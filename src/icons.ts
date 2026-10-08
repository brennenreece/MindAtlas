import { addIcon, setIcon } from "obsidian";
import * as feather from "feather-icons";

const LIB = feather.icons as unknown as Record<string, { contents: string }>;
const ALL = Object.keys(LIB);
const PREFIX = "feather-";

// Lucide names (older notes, Obsidian-style names) mapped to their Feather equivalents.
const ALIASES: Record<string, string> = {
  "check-square": "check-square", "square-check": "check-square", "check-circle": "check-circle", "circle-check": "check-circle",
  "circle-dot": "disc", "alert-circle": "alert-circle", "circle-alert": "alert-circle", "alert-triangle": "alert-triangle",
  "triangle-alert": "alert-triangle", "help-circle": "help-circle", "circle-help": "help-circle", "pause-circle": "pause-circle",
  "circle-pause": "pause-circle", "mouse-pointer-2": "mouse-pointer", "locate-fixed": "crosshair", pencil: "edit-2",
  shapes: "grid", eraser: "x", palette: "droplet", "chevrons-up-down": "chevrons-down", "chevrons-down-up": "chevrons-up",
  "file-plus": "file-plus", "link-2": "link-2", "more-horizontal": "more-horizontal", "rotate-ccw": "rotate-ccw",
};

let registered = false;
/** Register every Feather icon with Obsidian as "feather-<name>". Call once on load. */
export function registerFeatherIcons() {
  if (registered) return;
  registered = true;
  for (const name of ALL) {
    const inner = LIB[name].contents;
    // Feather is drawn on a 24-unit grid; Obsidian expects 100.
    addIcon(
      PREFIX + name,
      `<g transform="scale(4.1667)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</g>`
    );
  }
}

/** Resolve a stored icon name (or an old Lucide name) to a Feather name, else null. */
export function resolveIcon(name: string): string | null {
  const n = name.toLowerCase().trim();
  if (LIB[n]) return n;
  const alias = ALIASES[n];
  return alias && LIB[alias] ? alias : null;
}

/** The Obsidian icon id for a Feather name (or a Lucide name that has a Feather equivalent). */
export function fi(name: string): string {
  const r = resolveIcon(name);
  return r ? PREFIX + r : name;
}

/** Draw a Feather icon into an element, falling back to Obsidian's own set. */
export function setFeather(el: HTMLElement, name: string) {
  setIcon(el, fi(name));
}

const CATEGORIES: [string, string][] = [
  ["Tasks & status", "square check-square minus-square plus-square x-square circle check-circle x-circle minus-circle plus-circle disc stop-circle play-circle pause-circle clipboard list toggle-left toggle-right flag bookmark star heart award target thumbs-up thumbs-down check x loader"],
  ["Alerts & info", "alert-circle alert-triangle alert-octagon x-octagon info help-circle bell bell-off zap zap-off shield shield-off eye eye-off lock unlock key"],
  ["Time & places", "clock calendar watch sunrise sunset map map-pin compass navigation navigation-2 globe home anchor truck"],
  ["People & communication", "user users user-check user-minus user-plus user-x mail inbox send message-circle message-square phone phone-call phone-incoming phone-outgoing phone-forwarded phone-missed phone-off mic mic-off voicemail smile meh frown at-sign share share-2 rss cast"],
  ["Files & writing", "file file-text file-plus file-minus folder folder-plus folder-minus book book-open archive paperclip edit edit-2 edit-3 copy save printer type bold italic underline align-left align-center align-right align-justify hash tag link link-2 external-link scissors trash trash-2 delete"],
  ["Media", "image camera camera-off film video video-off music headphones speaker volume volume-1 volume-2 volume-x play pause fast-forward rewind skip-back skip-forward radio disc aperture"],
  ["Work & money", "briefcase dollar-sign credit-card shopping-cart shopping-bag package gift percent bar-chart bar-chart-2 pie-chart activity trending-up trending-down box layers tool settings sliders life-buoy feather pen-tool crop"],
  ["Tech & code", "code terminal command cpu database server hard-drive monitor smartphone tablet tv wifi wifi-off bluetooth battery battery-charging power git-branch git-commit git-merge git-pull-request github gitlab codepen codesandbox chrome figma framer trello slack twitter facebook instagram linkedin youtube twitch dribbble"],
  ["Nature & weather", "sun moon cloud cloud-rain cloud-snow cloud-drizzle cloud-lightning cloud-off droplet wind umbrella thermometer coffee"],
  ["Shapes & arrows", "triangle hexagon octagon grid columns layout sidebar table menu minus plus divide divide-circle divide-square slash arrow-up arrow-down arrow-left arrow-right arrow-up-right arrow-up-left arrow-down-right arrow-down-left arrow-up-circle arrow-down-circle arrow-left-circle arrow-right-circle chevron-up chevron-down chevron-left chevron-right chevrons-up chevrons-down chevrons-left chevrons-right corner-down-left corner-down-right corner-left-down corner-left-up corner-right-down corner-right-up corner-up-left corner-up-right refresh-cw refresh-ccw rotate-cw rotate-ccw repeat shuffle download upload download-cloud upload-cloud log-in log-out maximize maximize-2 minimize minimize-2 move crosshair mouse-pointer search filter zoom-in zoom-out more-horizontal more-vertical airplay"],
];

/** Feather icons grouped for the palette; to-do style icons come first. Nothing is left out. */
export function iconCategories(): { title: string; icons: string[] }[] {
  const used = new Set<string>();
  const out = CATEGORIES.map(([title, list]) => {
    const icons = list.split(" ").filter((n) => LIB[n] && !used.has(n));
    icons.forEach((n) => used.add(n));
    return { title, icons };
  });
  const rest = ALL.filter((n) => !used.has(n));
  if (rest.length) out.push({ title: "More", icons: rest });
  return out.filter((c) => c.icons.length);
}

/** An <svg> element for the icon, ready to place inside another SVG. */
export function iconSvg(name: string): SVGSVGElement | null {
  const tmp = document.createElement("div");
  setIcon(tmp, fi(name));
  return tmp.querySelector("svg") as SVGSVGElement | null;
}
