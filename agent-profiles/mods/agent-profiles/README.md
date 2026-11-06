# Agent profiles

A standalone native Herdr mod with a searchable agent/profile editor and a
launcher. It uses the existing saved profiles and per-machine launcher order.

Open the profile manager:

```sh
herdr-app do mod.open --name agent-profiles
```

Search or select a row to edit default arguments or a named profile. New profile,
Duplicate, Save, Remove, and Discard work independently for each configuration.
Unsaved drafts survive switching rows, searching, and opening the launcher from
the manager. Drag rows or their grips to reorder; the launcher uses that order.
On narrow windows, the list stacks above the scrolling editor.

**Open launcher** shows available agents and their saved profiles. Click a row
to launch it. Up/Down select rows; Enter and 1–9 launch. **Back to profiles**
returns to the manager with its draft intact. A separately opened launcher uses
**Edit profiles** to open this mod at the selected configuration.

Another mod can open the popup:

```js
openOverlay({
  mod: "agent-profiles",
  kind: "popup",
  width: 440,
  height: 480,
  props: { view: "launcher" },
});
```

The manager accepts `props: { view: "profiles", agent, profile, machine }`.
Omitting `machine` uses the active space's machine; `null` chooses this device.

Default arguments update `programs.json`; named profiles update
`agent-launch-profiles.json`, both under Herdr's app home. Order and last-launched
selection use the existing `personal-launcher.order` and
`personal-launcher.selection` shared keys. Saves preserve unrelated settings and
report conflicting changes. Agent arguments are passed as argv, with no shell
expansion. Paths refer to the machine running the agent.

Tested on Herdr 0.1.11. From this mod folder, with Node 22.15 or newer:

```sh
node --test --test-isolation=none tests/*.test.mjs
herdr-app check .
```
