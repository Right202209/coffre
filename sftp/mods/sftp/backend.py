"""SFTP over the user's OpenSSH transport; JSON in/out, never a shell command.

Paramiko handles SFTP framing. OpenSSH handles configuration, ProxyJump, agents,
encrypted keys, host verification and optional interactive authentication.
"""

import contextlib
import hashlib
import json
import os
from pathlib import Path
import posixpath
import re
import select
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid

import paramiko


class Cancelled(Exception):
    pass


def checked_connection(value):
    value = value or {}
    target = str(value.get("target", "")).strip()
    if not re.fullmatch(r"[A-Za-z0-9_@.:[\]%-]+", target) or target.startswith("-"):
        raise ValueError("主机地址无效：请输入 SSH 别名或 user@host")
    user = str(value.get("user", "")).strip()
    if user and not re.fullmatch(r"[A-Za-z0-9_.-]+", user):
        raise ValueError("SSH 用户名无效")
    port = str(value.get("port", "")).strip()
    if port and (not port.isdecimal() or not 1 <= int(port) <= 65535):
        raise ValueError("端口必须在 1–65535 之间")
    key = str(value.get("key", "")).strip()
    if key and ("\x00" in key or "\n" in key):
        raise ValueError("密钥路径无效")
    return {"target": target, "user": user, "port": port, "key": key}


def private_dir(path):
    path = Path(path)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.is_symlink() or path.stat().st_uid != os.getuid():
        raise ValueError("SFTP 状态目录不属于当前用户")
    path.chmod(0o700)
    return path


def ssh_args(connection, state, interactive=False):
    c = checked_connection(connection)
    # Short paths also work under OpenSSH's Unix socket length limit.
    sockets = private_dir(Path(tempfile.gettempdir()) / f"herdr-sftp-{os.getuid()}")
    identity = json.dumps([str(Path(state).resolve()), c], sort_keys=True)
    control = str(sockets / hashlib.sha256(identity.encode()).hexdigest()[:24])
    args = ["ssh", "-T", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=5",
            "-o", "ServerAliveCountMax=2", "-o", f"ControlPath={control}",
            "-o", f"BatchMode={'no' if interactive else 'yes'}",
            "-o", f"StrictHostKeyChecking={'ask' if interactive else 'yes'}"]
    if interactive:
        args += ["-o", "ControlMaster=auto", "-o", "ControlPersist=600"]
    if c["port"]:
        args += ["-p", c["port"]]
    if c["user"]:
        args += ["-l", c["user"]]
    if c["key"]:
        args += ["-i", os.path.expanduser(c["key"])]
    if not interactive:
        args += ["-s"]
    return args + ["--", c["target"], "true" if interactive else "sftp"]


class PipeSocket:
    def __init__(self, process):
        self.process = process

    def get_name(self):
        return "openssh-sftp"

    def send(self, data):
        _, writable, _ = select.select([], [self.process.stdin], [], 20)
        if not writable:
            raise TimeoutError("SFTP 写入超时")
        return os.write(self.process.stdin.fileno(), data)

    def recv(self, size):
        readable, _, _ = select.select([self.process.stdout], [], [], 20)
        if not readable:
            raise TimeoutError("SFTP 服务器响应超时")
        return os.read(self.process.stdout.fileno(), size)

    def close(self):
        self.process.stdin.close()


@contextlib.contextmanager
def sftp_connection(argv):
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=errors, bufsize=0, start_new_session=True)
        client = None
        try:
            client = paramiko.SFTPClient(PipeSocket(process))
            yield client
        except (EOFError, paramiko.SSHException, BrokenPipeError) as exc:
            errors.seek(0)
            detail = errors.read(4000).decode("utf-8", "replace").strip()
            raise ConnectionError(detail or str(exc) or "SFTP 连接已断开") from exc
        finally:
            if client:
                with contextlib.suppress(Exception):
                    client.close()
            if process.poll() is None:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    with contextlib.suppress(ProcessLookupError):
                        os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            process.stdout.close()
            if not process.stdin.closed:
                process.stdin.close()


def entry(name, attributes):
    mode = attributes.st_mode or 0
    return {"name": name, "directory": stat.S_ISDIR(mode), "link": stat.S_ISLNK(mode),
            "regular": stat.S_ISREG(mode), "size": attributes.st_size or 0,
            "modified": attributes.st_mtime or 0, "permissions": stat.filemode(mode)}


def remote_path(client, path):
    path = path or "."
    if path == "~":
        path = "."
    elif path.startswith("~/"):
        path = posixpath.join(client.normalize("."), path[2:])
    return client.normalize(path)


def list_files(request, client=None):
    path = request.get("path") or ("." if client else "~")
    path = remote_path(client, path) if client else str(Path(path).expanduser().resolve())
    rows = []
    if client:
        for attr in client.listdir_iter(path, read_aheads=4):
            if attr.filename in (".", ".."):
                continue
            if "/" in attr.filename or "\x00" in attr.filename:
                raise ValueError("服务器返回了无效的文件名")
            item = entry(attr.filename, attr)
            rows.append(item)
            if len(rows) > 10000:
                raise ValueError("目录超过 10,000 项，请输入更具体的路径")
        # Drain pipelined READDIR replies before issuing any other requests.
        for item in rows:
            if item["link"]:
                with contextlib.suppress(OSError):
                    item["directory"] = stat.S_ISDIR(client.stat(posixpath.join(path, item["name"])).st_mode)
    else:
        with os.scandir(path) as files:
            for f in files:
                try:
                    item = entry(f.name, f.stat(follow_symlinks=False))
                    if item["link"]:
                        item["directory"] = f.is_dir()
                    rows.append(item)
                except FileNotFoundError:
                    continue
                if len(rows) > 10000:
                    raise ValueError("目录超过 10,000 项，请输入更具体的路径")
    rows.sort(key=lambda row: (not row["directory"], row["name"].casefold()))
    return {"path": path, "entries": rows}


def validate_name(name):
    if not isinstance(name, str) or name in ("", ".", "..") or any(c in name for c in "/\x00\r\n"):
        raise ValueError("请输入有效的文件夹名称")
    return name


def perform(request, client=None):
    if request["op"] == "list":
        return list_files(request, client)
    if request["op"] == "mkdir":
        name = validate_name(request.get("name"))
        if client:
            client.mkdir(posixpath.join(remote_path(client, request["path"]), name))
        else:
            (Path(request["path"]).expanduser() / name).mkdir()
        return {"created": name}
    raise ValueError("未知操作")


def atomic_json(path, data):
    temp = path.with_suffix(".tmp")
    with open(temp, "w", encoding="utf-8") as stream:
        json.dump(data, stream, ensure_ascii=False)
    os.replace(temp, path)


def job_dir(state, job_id):
    if not re.fullmatch(r"[a-f0-9]{32}", job_id):
        raise ValueError("无效的传输任务")
    return Path(state) / "jobs" / job_id


class Progress:
    def __init__(self, folder):
        self.folder = folder
        self.started = time.monotonic()
        self.updated = 0
        self.bytes = 0
        self.total = 0

    def check(self):
        if (self.folder / "cancel").exists():
            raise Cancelled("传输已取消")
        if time.time() - (self.folder / "lease").stat().st_mtime > 45:
            raise Cancelled("面板已关闭，传输已取消")
        if time.monotonic() - self.started > 3600:
            raise TimeoutError("传输超过一小时，请使用命令行继续")

    def report(self, count, total):
        self.bytes, self.total = count, total
        self.check()
        if time.monotonic() - self.updated > 0.25:
            self.updated = time.monotonic()
            atomic_json(self.folder / "status.json", {"state": "running", "bytes": count, "total": total})


def transfer(request, client, progress, token):
    source, destination = request["source"], request["destination"]
    upload = request["op"] == "upload"
    temporary = destination + f".herdr-sftp-{token}.part"
    published = False
    created = False
    try:
        if upload:
            # Never follow a local symlink or overwrite an existing remote entry.
            fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as local:
                info = os.fstat(local.fileno())
                if not stat.S_ISREG(info.st_mode):
                    raise ValueError("仅支持传输普通文件；请先进入文件夹")
                try:
                    client.lstat(destination)
                except FileNotFoundError:
                    pass
                else:
                    raise FileExistsError("目标已存在，请更改文件名后重试")
                total = info.st_size
                with client.open(temporary, "wx") as remote:
                    created = True
                    count = 0
                    progress.report(count, total)
                    while data := local.read(128 * 1024):
                        progress.check()
                        remote.write(data)
                        count += len(data)
                        progress.report(count, total)
                current = os.fstat(local.fileno())
                if count != total or current.st_mtime_ns != info.st_mtime_ns:
                    raise OSError("源文件在传输中发生变化，请重试")
            progress.check()
            # SFTP v3 rename refuses existing destinations (do not use posix_rename).
            client.rename(temporary, destination)
            published = True
        else:
            info = client.lstat(source)
            if not stat.S_ISREG(info.st_mode):
                raise ValueError("仅支持传输普通文件；请先进入文件夹")
            if os.path.lexists(destination):
                raise FileExistsError("目标已存在，请更改文件名后重试")
            total = info.st_size
            with open(temporary, "xb") as local:
                created = True
                with client.open(source, "rb") as remote:
                    count = 0
                    progress.report(count, total)
                    while data := remote.read(128 * 1024):
                        progress.check()
                        local.write(data)
                        count += len(data)
                        progress.report(count, total)
                local.flush()
                os.fsync(local.fileno())
            current = client.lstat(source)
            if count != total or info.st_mtime != current.st_mtime or info.st_size != current.st_size:
                raise OSError("源文件在传输中发生变化，请重试")
            progress.check()
            os.link(temporary, destination)  # Exclusive publication on the same filesystem.
            published = True
        return {"bytes": count, "total": total, "destination": destination}
    finally:
        if created and (not upload or not published):
            try:
                client.remove(temporary) if upload else os.unlink(temporary)
            except FileNotFoundError:
                pass
            except OSError as exc:
                raise OSError(f"临时文件清理失败，请检查 {temporary}: {exc}") from exc


def worker(state, job_id):
    os.umask(0o077)
    folder = job_dir(state, job_id)
    progress = Progress(folder)
    try:
        request = json.loads((folder / "request.json").read_text())
        progress.check()
        with sftp_connection(ssh_args(request["connection"], state)) as client:
            result = transfer(request, client, progress, job_id)
        result["state"] = "done"
    except Cancelled as exc:
        result = {"state": "cancelled", "error": str(exc)}
    except Exception as exc:
        result = {"state": "error", "error": str(exc)[:2000]}
    result.setdefault("bytes", progress.bytes)
    result.setdefault("total", progress.total)
    atomic_json(folder / "status.json", result)
    (folder / "request.json").unlink(missing_ok=True)


def dispatch(state, request):
    private_dir(state)
    op = request.get("op")
    if op == "auth":
        return {"argv": ssh_args(request["connection"], state, interactive=True)}
    if op == "start":
        task = request["task"]
        if task.get("op") not in ("upload", "download"):
            raise ValueError("无效的传输类型")
        checked_connection(task["connection"])
        job_id = uuid.uuid4().hex
        folder = private_dir(job_dir(state, job_id))
        (folder / "lease").touch()
        atomic_json(folder / "request.json", task)
        atomic_json(folder / "status.json", {"state": "running", "bytes": 0, "total": 0})
        subprocess.Popen([sys.executable, __file__, "--worker", str(state), job_id],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
        return {"id": job_id}
    if op in ("status", "cancel"):
        folder = job_dir(state, request["id"])
        if op == "cancel":
            (folder / "cancel").touch()
        (folder / "lease").touch()
        return json.loads((folder / "status.json").read_text())
    if request.get("connection"):
        with sftp_connection(ssh_args(request["connection"], state)) as client:
            return perform(request, client)
    return perform(request)


if __name__ == "__main__":
    os.umask(0o077)
    if sys.argv[1] == "--worker":
        worker(sys.argv[2], sys.argv[3])
    else:
        try:
            def timed_out(_signum, _frame):
                raise TimeoutError("操作超时，请重试或输入更具体的目录")

            # Leave room for transport cleanup before Herdr's 30-second exec limit.
            signal.signal(signal.SIGALRM, timed_out)
            signal.alarm(24)
            result = dispatch(sys.argv[1], json.loads(sys.argv[2]))
            print(json.dumps({"ok": True, **result}, ensure_ascii=False))
        except Exception as exc:
            print(json.dumps({"ok": False, "error": str(exc)[:2000]}, ensure_ascii=False))
            sys.exit(1)
