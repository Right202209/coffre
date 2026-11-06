"""Exercise the actual SFTP protocol against OpenSSH's local sftp-server."""

import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("backend", Path(__file__).parents[1] / "mods/sftp/backend.py")
backend = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backend)
SERVER = next((p for p in ("/usr/lib/ssh/sftp-server", "/usr/lib/openssh/sftp-server", "/usr/libexec/sftp-server") if Path(p).exists()), None)


class Progress:
    def __init__(self, cancel=False):
        self.count = 0
        self.cancel = cancel

    def check(self):
        if self.cancel and self.count:
            raise backend.Cancelled("cancelled")

    def report(self, count, total):
        self.count = count
        self.check()


class ValidationTests(unittest.TestCase):
    def test_rejects_options_shell_fragments_and_bad_ports(self):
        for target in ("-oProxyCommand=touch bad", "a;id", "$(id)", "host\nother", "a b", ""):
            with self.subTest(target=target), self.assertRaises(ValueError):
                backend.checked_connection({"target": target})
        for port in ("0", "65536", "22oops"):
            with self.subTest(port=port), self.assertRaises(ValueError):
                backend.checked_connection({"target": "host", "port": port})

    def test_ssh_config_is_preserved_and_trust_is_strict(self):
        with tempfile.TemporaryDirectory() as state:
            args = backend.ssh_args({"target": "ali", "key": "/tmp/key with ' and spaces"}, state)
            self.assertIn("StrictHostKeyChecking=yes", args)
            self.assertIn("BatchMode=yes", args)
            self.assertIn("/tmp/key with ' and spaces", args)
            self.assertNotIn("-F", args)
            self.assertEqual(args[-4:], ["-s", "--", "ali", "sftp"])
            auth = backend.ssh_args({"target": "ali"}, state, interactive=True)
            self.assertIn("StrictHostKeyChecking=ask", auth)
            self.assertIn("ControlPersist=600", auth)

    def test_job_ids_and_directory_names_cannot_escape(self):
        with self.assertRaises(ValueError):
            backend.job_dir("/tmp", "../../etc")
        for name in ("..", ".", "", "a/b", "x\x00"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                backend.validate_name(name)


@unittest.skipUnless(SERVER, "OpenSSH sftp-server not available")
class SftpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="herdr-sftp-test-")
        self.root = Path(self.temp.name)
        self.context = backend.sftp_connection([SERVER])
        self.client = self.context.__enter__()

    def tearDown(self):
        self.context.__exit__(None, None, None)
        self.temp.cleanup()

    def test_listing_unicode_spaces_links_and_hidden_files(self):
        (self.root / "中文 (folder)").mkdir()
        (self.root / "a' [name]\n.txt").write_text("hello")
        (self.root / ".hidden").write_bytes(b"x")
        (self.root / "link").symlink_to(self.root / "中文 (folder)")
        result = backend.list_files({"path": str(self.root)}, self.client)
        rows = {row["name"]: row for row in result["entries"]}
        self.assertEqual(rows["a' [name]\n.txt"]["size"], 5)
        self.assertTrue(rows["link"]["directory"])
        self.assertTrue(rows["link"]["link"])
        self.assertIn(".hidden", rows)
        self.assertEqual(result["path"], str(self.root))
        local = backend.list_files({"path": str(self.root)})
        self.assertEqual({e["name"] for e in local["entries"]}, set(rows))

    def test_mkdir_and_missing_directory(self):
        backend.perform({"op": "mkdir", "path": str(self.root), "name": "中文 folder"}, self.client)
        self.assertTrue((self.root / "中文 folder").is_dir())
        with self.assertRaises(OSError):
            backend.list_files({"path": str(self.root / "missing")}, self.client)

    def test_binary_round_trip_and_exclusive_destinations(self):
        source = self.root / "source '中文.bin"
        remote = self.root / "remote [file].bin"
        destination = self.root / "downloaded.bin"
        content = os.urandom(1024 * 1024 + 13)
        source.write_bytes(content)
        for op, src, dst in (("upload", source, remote), ("download", remote, destination)):
            request = {"op": op, "source": str(src), "destination": str(dst)}
            result = backend.transfer(request, self.client, Progress(), "test-token")
            self.assertEqual(result["bytes"], len(content))
            self.assertEqual(dst.read_bytes(), content)
            with self.assertRaises(FileExistsError):
                backend.transfer(request, self.client, Progress(), "test-token")
            self.assertEqual(dst.read_bytes(), content)
        self.assertFalse(list(self.root.glob("*.part")))

    def test_cancellation_removes_partial_upload_and_download(self):
        source = self.root / "source"
        source.write_bytes(os.urandom(300000))
        for op in ("upload", "download"):
            destination = self.root / f"cancelled-{op}"
            with self.subTest(op=op), self.assertRaises(backend.Cancelled):
                backend.transfer({"op": op, "source": str(source), "destination": str(destination)}, self.client, Progress(cancel=True), "cancel-test")
            self.assertFalse(destination.exists())
            self.assertFalse(list(self.root.glob("*.part")))

    def test_symlink_sources_and_destinations_are_not_followed(self):
        source = self.root / "source"
        source.write_text("original")
        link = self.root / "link"
        link.symlink_to(source)
        for op in ("upload", "download"):
            with self.subTest(op=op), self.assertRaises((ValueError, OSError)):
                backend.transfer({"op": op, "source": str(link), "destination": str(self.root / "copy")}, self.client, Progress(), "link-test")
            with self.subTest(op=op), self.assertRaises(FileExistsError):
                backend.transfer({"op": op, "source": str(source), "destination": str(link)}, self.client, Progress(), "link-test")
        self.assertEqual(source.read_text(), "original")

    def test_destination_created_during_transfer_is_preserved(self):
        source = self.root / "source"
        source.write_bytes(os.urandom(200000))
        for op in ("upload", "download"):
            destination = self.root / f"race-{op}"

            class RacingProgress(Progress):
                def report(self, count, total):
                    if count and not destination.exists():
                        destination.write_text("created by someone else")

            with self.subTest(op=op), self.assertRaises(OSError):
                backend.transfer({"op": op, "source": str(source), "destination": str(destination)}, self.client, RacingProgress(), "race-test")
            self.assertEqual(destination.read_text(), "created by someone else")
            self.assertFalse(list(self.root.glob("*.part")))

    def test_lost_ui_lease_cancels_worker(self):
        folder = self.root / "job"
        folder.mkdir()
        (folder / "lease").touch()
        os.utime(folder / "lease", (1, 1))
        with self.assertRaises(backend.Cancelled):
            backend.Progress(folder).check()

    def test_upload_rejects_fifo_without_waiting_for_a_writer(self):
        fifo = self.root / "pipe"
        os.mkfifo(fifo)
        with self.assertRaises(ValueError):
            backend.transfer({"op": "upload", "source": str(fifo), "destination": str(self.root / "copy")}, self.client, Progress(), "fifo-test")


if __name__ == "__main__":
    unittest.main()
