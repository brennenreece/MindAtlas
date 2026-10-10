# MindAtlas

Obsidian plugin that shows a mind map of the link graph around a note. No special structure is required: every `[[link]]` is an edge.

- **Focus note** is the root; outgoing links expand to the right, backlinks (toggle) to the left, to a chosen depth.
- Each note appears once, under the nearest note that links to it. Other links between visible notes are drawn as dashed cross-links. Arrowheads show link direction (an arrow at each end when two notes link to each other), and backlinks and their lines are grayed out.
- Relationships are explicit: `## Children` creates solid child lines, `## Parents` is its reciprocal, and `## Connections` creates dashed connection lines. A child may have more than one parent. On startup MindAtlas fills in missing reciprocal Children/Parents entries without deleting prose links; frontmatter `mindmap-ignore: true` hides a note.

**Layout:** deterministic radial, so the map is stable and tidy. Every branch gets its own wedge around the center, sized by how many notes it holds, and each generation sits on its own ring. Backlink notes get their own wedges too, with gray lines. Siblings are ordered to keep extra-parent and connection lines short, and a note that sits on a hierarchy line is nudged aside. **Lines** are straight whenever the way is clear, otherwise one gentle arc or a single gentle S-curve; only parent→child lines have arrowheads, and connections are dashed. Dragging a note into empty space saves its position in the frontmatter of the map's center note, under `mindmap-layout` (`offsets` are `path: [x, y]` shifts from each note's automatic spot, so branches follow; floating notes go under `free`). Each center note keeps its own layout. The embedded editor hides frontmatter and preserves it on save. **Re-tidy** (wand) removes the saved positions. Maps are capped at a configurable number of notes (default 400).

**Options** (Settings → MindAtlas): editor position (below or right of the map), default depth (3), max notes, branch colors, font, heading sizes, boxes, line thickness/color, cross-links (always / selected note only / hidden), and node spacing (also the toolbar's Spread button).

**Controls**
- Click a note to edit it in the embedded editor (with `[[` autocomplete). Click a `[[link]]` in the editor to open it; an unresolved link creates the note first. Scroll to pan, Cmd/Ctrl+scroll to zoom.
- **Keyboard** (map focused): arrows navigate (Up = parent, Down = first child, Left/Right = previous/next in the same generation); **Tab** = new child; **Enter** = new sibling; **F2** = rename; **Space** = collapse/expand; **Delete** = delete; **R** or double-click = make the note the center; **+ / − / 0** = zoom / fit; **Cmd/Ctrl+Z**, **Shift+Z** = undo/redo; **Cmd/Ctrl+F** = find a note.
- The getting-started guide appears the first time you open a map. All map controls remain directly in the toolbar; to reopen the guide, use **MindAtlas: Show getting started guide** in Obsidian's Command Palette.
- **Hover menu** (tap on touch devices): add child, rename, make center, link, color (Kelly's 22 colors), more…, delete.
- **Right-click menu:** rename, re-root, collapse, open in a tab, color, icon, copy branch as outline. Color and icon are stored in frontmatter (`mindmap-color`, `mindmap-icon`; colors are inherited by descendants). The hover menu's icon button opens a palette of Feather-style icons, shown centered above the node in the node's color (size set in Settings → Icon size); `mindmap-icon` can also hold an emoji, which is shown before the title. An old `mindmap-status` is shown as an icon.
- **Re-parent or connect:** drag a note onto another note (or use the Link tool, or drag a file from the sidebar onto a node), then choose **Child** or **Connection**. Child puts it under the target's `## Children`; Connection leaves the note where it is and adds a link under `## Connections` (a dashed line).
- **All connections** (checkbox in the top toolbar, also in Settings): also shows notes linked to or from the notes on the map that aren't children of anything. They float on a ring outside the map, joined only by dashed lines, and you can drag them anywhere.
- **Palette:** Select, Add note, Link, zoom, center, fit, find, undo, redo, re-tidy, export (SVG, PNG, markdown outline).

**Hierarchy:** only links listed beneath the three relationship headings affect the map. Children and Parents are maintained in both directions; Connections are directed dashed references. Once a note has relationship headings, prose links remain untouched and do not create map lines. Moving a note edits the relationship lists, so prose links are left alone.

Every structural change edits the notes themselves: new links are added as `- [[Note]]` under a `## Children` heading; removing a link deletes its list item, or turns an inline link into plain text. Undo restores the affected notes' content and refuses if they were edited since. Renaming clears undo history.

Lines attach where the line between two notes meets their boxes.

## Develop
1. `npm install && npm run dev`
2. Symlink this folder to `<test-vault>/.obsidian/plugins/mind-atlas` and enable it (`.hotreload` works with the Hot Reload plugin).
3. Run **MindAtlas: Open map for current note**.

## Testing on iPhone / iPad

Install MindAtlas through BRAT using the `brennenreece/MindAtlas` repository, then reload Obsidian after BRAT updates the plugin. For local development, use the build and vault-symlink steps above.
