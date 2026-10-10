# MindAtlas

Obsidian plugin that shows a mind map of the link graph around a note. No special structure is required: every `[[link]]` is an edge.

- **Focus note** is the root; outgoing links expand to the right, backlinks (toggle) to the left, to a chosen depth.
- Each note appears once, under the nearest note that links to it. Other links between visible notes are drawn as dashed cross-links. Arrowheads show link direction (an arrow at each end when two notes link to each other), and backlinks and their lines are grayed out.
- Relationships are explicit and live in one block at the bottom of each note:

  ```
  ## Map
  ### Children
  - [[Child]] optional remark
  ### Connections
  - [[Related]]
  ```

  Children are solid lines, Connections are dashed. Parents are never stored: a note's parents are the notes that list it under Children, so a note may have any number of them. On startup MindAtlas migrates older notes (separate `## Children`/`## Connections`/`## Parents` sections) into this block, turning each `## Parents` entry into an entry in that parent's Children; prose links are left alone. Frontmatter `mindmap-ignore: true` hides a note.

**Layout:** deterministic radial, so the map is stable and tidy. Every branch gets its own wedge around the center, sized by how many notes it holds, and each generation sits on its own ring. Backlink notes get their own wedges too, with gray lines. Siblings are ordered to keep extra-parent and connection lines short, and a note that sits on a hierarchy line is nudged aside. **Lines** are straight whenever the way is clear, otherwise one gentle arc or a single gentle S-curve; only parent→child lines have arrowheads, and connections are dashed. Dragging a note into empty space saves its position in the frontmatter of the map's center note, under `mindmap-layout` (`offsets` are `path: [x, y]` shifts from each note's automatic spot, so branches follow; floating notes go under `free`). Each center note keeps its own layout. The embedded editor hides frontmatter and preserves it on save. **Re-tidy** (wand) removes the saved positions. Maps are capped at a configurable number of notes (default 400).

**Options** (Settings → MindAtlas): default depth (3), max notes, branch colors, font, heading sizes, boxes, line thickness/color, cross-links (always / selected note only / hidden), and node spacing (also the toolbar's Spread button).

**Controls**
- Click a note to open it in a Markdown pane beside the map (one pane is reused for every click). Scroll to pan, Cmd/Ctrl+scroll to zoom.
- **Keyboard** (map focused): arrows navigate (Up = parent, Down = first child, Left/Right = previous/next in the same generation); **Tab** = new child; **Enter** = new sibling; **F2** = rename; **Space** = collapse/expand; **Delete** = delete; **R** or double-click = make the note the center; **+ / − / 0** = zoom / fit; **Cmd/Ctrl+Z**, **Shift+Z** = undo/redo; **Cmd/Ctrl+F** = find a note.
- The getting-started guide appears the first time you open a map. All map controls remain directly in the toolbar; to reopen the guide, use **MindAtlas: Show getting started guide** in Obsidian's Command Palette.
- **Hover menu** (tap on touch devices): add child, rename, make center, link, color (Kelly's 22 colors), more…, delete.
- **Right-click menu:** rename, re-root, collapse, open in a tab, color, icon, copy branch as outline. Color and icon are stored in frontmatter (`mindmap-color`, `mindmap-icon`; colors are inherited by descendants). The hover menu's icon button opens a palette of Feather-style icons, shown centered above the node in the node's color (size set in Settings → Icon size); `mindmap-icon` can also hold an emoji, which is shown before the title. An old `mindmap-status` is shown as an icon.
- **Re-parent or connect:** drag a note onto another note (or use the Link tool, or drag a file from the sidebar onto a node), then choose **Child** or **Connection**. Child puts it under the target's Children; Connection leaves the note where it is and adds a link under Connections (a dashed line).
- **All connections** (checkbox in the top toolbar, also in Settings): also shows notes linked to or from the notes on the map that aren't children of anything. They float on a ring outside the map, joined only by dashed lines, and you can drag them anywhere.
- **Keeping it tidy:** a note shows at most 8 children (setting: *Children shown per note*) with a "+N more" button for the rest; backlinks are hidden behind "+N backlinks" until clicked (setting: *Collapse backlinks*); the "+N" and "…" badges collapse or expand a branch. **Focus** (toolbar) dims everything except the selected note's parents, children and siblings. **Tidy** (toolbar) scans every note on the map and lists links to themselves, repeated entries, connections that duplicate a parent/child or another connection, and child links already implied through another child; fix them one at a time or all at once. A note can't be linked or connected to itself, and a pair that already has a relationship can't also be connected.
- **Palette:** Select, Add note, Link, zoom, center, fit, find, undo, redo, re-tidy, export (SVG, PNG, markdown outline).

**Hierarchy:** only links listed under `### Children` and `### Connections` affect the map; Connections are directed dashed references. Prose links stay untouched and do not create map lines. Moving a note edits the relationship lists only.

**Line labels:** write a remark after a link in the Map block (`- [[Note]] — why`) and it appears at the middle of that line. Only the Map block is read. Double-click a line (or right-click → Add/Edit label) to edit it; clearing the text removes the remark. Toggle in settings → "Show line labels".

Every structural change edits the notes themselves: new links are added as `- [[Note]]` under `### Children` in the `## Map` block; removing a link deletes its list item, or turns an inline link into plain text. Undo restores the affected notes' content and refuses if they were edited since. Renaming clears undo history.

Lines attach where the line between two notes meets their boxes.

## Develop
1. `npm install && npm run dev`
2. Symlink this folder to `<test-vault>/.obsidian/plugins/mind-atlas` and enable it (`.hotreload` works with the Hot Reload plugin).
3. Run **MindAtlas: Open map for current note**.

## Testing on iPhone / iPad

Install MindAtlas through BRAT using the `brennenreece/MindAtlas` repository, then reload Obsidian after BRAT updates the plugin. For local development, use the build and vault-symlink steps above.
