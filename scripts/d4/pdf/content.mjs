/**
 * D4 PDF fixture generator — fixture content definitions (B1 acceptance set).
 *
 * Every fixture carries real, meaningful bilingual programming/learning notes
 * (TreeAI's content theme). Content is pure data + a per-fixture build()
 * driving the shared LayoutDoc flow engine; nothing here hand-writes offsets
 * or canonical text — that is always derived by layout + the pinned reading
 * order.
 *
 * Font roles used by fixtures:
 *   songti  CID subset of /System/Library/Fonts/Supplemental/Songti.ttc (#0)
 *   stheiti CID subset of /System/Library/Fonts/STHeiti Light.ttc (#0)
 *           (combining marks, Ext-A, Ext-B astral, U+3007, U+F8FF)
 *   arialu  CID subset of /System/Library/Fonts/Supplemental/Arial Unicode.ttf
 *           (U+FFFD; the only probed system font with a glyph there)
 *   helv / helv-bold / courier  base-14 Type1 (WinAnsiEncoding)
 */


import { FIXTURE_GROUP as F1 } from "./content/fixtures-01-03.mjs";
import { FIXTURE_GROUP as F2 } from "./content/fixtures-04-06.mjs";
import { FIXTURE_GROUP as F3 } from "./content/fixtures-07-09.mjs";
import { FIXTURE_GROUP as F4 } from "./content/fixtures-10-12.mjs";

/** Stable B1 order and IDs; the fixtures contain the original rendering routines. */
export const FIXTURES = [...F1, ...F2, ...F3, ...F4];
