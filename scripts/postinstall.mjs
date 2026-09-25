import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(
  root,
  "node_modules/@audiotool/nexus/dist/synced-document-ywEybIAl.js"
);

if (!existsSync(target)) {
  console.warn("[postinstall] nexus synced-document not found, skipping pointer guard patch");
  process.exit(0);
}

let src = readFileSync(target, "utf8");

const needle = `      if (t.T.name === q.name) {
        const a = n;
        return new q({
          fieldIndex: a.fieldIndex.slice(),
          entityId: a.entityId
        });
      }`;

const replacement = `      if (t.T.name === q.name) {
        const a = n;
        const fi = a && a.fieldIndex;
        if (fi === void 0) {
          console.error(
            "[METATRON SDKI] pointer converter received value without fieldIndex; field=",
            t.localName,
            "in=",
            t.parent && t.parent.typeName,
            "value=",
            a,
            "keys=",
            a ? Object.keys(a) : null
          );
          if (a && a.entityId !== void 0) {
            return new q({
              fieldIndex: [],
              entityId: a.entityId
            });
          }
          return ri(
            i,
            e,
            a
          ), e;
        }
        return new q({
          fieldIndex: fi.slice(),
          entityId: a.entityId
        });
      }`;

// an older generation of the guard (86c1003) may already be applied; revert it
const oldGeneration = `      if (t.T.name === q.name) {
        const a = n;
        const fi = a && a.fieldIndex;
        if (fi === void 0) {
          console.error(
            "[METATRON SDKI] pointer converter received value without fieldIndex; field=",
            t.localName,
            "in=",
            t.parent && t.parent.typeName,
            "value=",
            a,
            "keys=",
            a ? Object.keys(a) : null
          );
          return new q({
            fieldIndex: [],
            entityId: a && a.entityId
          });
        }
        return new q({
          fieldIndex: fi.slice(),
          entityId: a.entityId
        });
      }`;

const finalMarker = "return ri(\n            i,\n            e,\n            a\n          ), e;";

if (src.includes(finalMarker)) {
  console.log("[postinstall] pointer guard already applied, skipping");
  process.exit(0);
}

if (src.includes("METATRON SDKI")) {
  if (!src.includes(oldGeneration)) {
    console.warn("[postinstall] existing pointer patch has an unknown shape, cannot revert cleanly");
    process.exit(1);
  }
  src = src.replace(oldGeneration, needle);
  writeFileSync(target, src, "utf8");
  console.log("[postinstall] reverted prior pointer guard patch");
}

if (!src.includes(needle)) {
  console.warn("[postinstall] expected converter block not found, patch NOT applied");
  process.exit(1);
}

writeFileSync(target, src.replace(needle, replacement), "utf8");
console.log("[postinstall] applied pointer fieldIndex guard to synced-document-ywEybIAl.js");