#!/usr/bin/env osascript -l JavaScript
//
// Reads the macOS general pasteboard and reports what it holds, as JSON on stdout.
// Runs on the LOCAL Mac (the extension is `extensionKind: ui`), so this sees the
// user's real clipboard even when the VS Code window is attached to a remote host.
//
// Output shape:
//   { kind: 'files', paths: string[] }   - files copied in Finder (any type: zip, mov, pdf, ...)
//   { kind: 'image', paths: [string] }   - in-memory image (screenshot), materialised as PNG
//   { kind: 'other', types: string[] }   - text or anything else; caller falls through to a normal paste
//   { kind: 'error', message: string }
//
ObjC.import('AppKit');

/**
 * Absolute POSIX paths of every file reference on the pasteboard, in clipboard order.
 *
 * Reads two independent flavors and keeps the richer answer. Neither alone is
 * reliable: NSURL reads can under-report a multi-item pasteboard, and the legacy
 * NSFilenamesPboardType is deprecated (though macOS still synthesises it from
 * public.file-url items, so Finder multi-selections come through).
 *
 * Note JXA returns ObjC `count` as a *string*, so it must be coerced before use.
 */
function fileUrlPaths(pb) {
  const viaUrls = [];
  const opts = $.NSDictionary.dictionaryWithObjectForKey(
    $.NSNumber.numberWithBool(true),
    $.NSPasteboardURLReadingFileURLsOnlyKey
  );
  const objs = pb.readObjectsForClassesOptions($([$.NSURL]), opts);
  if (!objs.isNil()) {
    const n = Number(objs.count) || 0;
    for (let i = 0; i < n; i++) {
      const p = objs.objectAtIndex(i).path;
      if (!p.isNil()) viaUrls.push(ObjC.unwrap(p));
    }
  }

  let viaFilenames = [];
  const pl = pb.propertyListForType($('NSFilenamesPboardType'));
  if (!pl.isNil()) {
    const unwrapped = ObjC.deepUnwrap(pl);
    if (Array.isArray(unwrapped)) viaFilenames = unwrapped.filter(p => typeof p === 'string');
  }

  const merged = viaFilenames.length > viaUrls.length ? viaFilenames : viaUrls;
  return merged.filter((p, i) => merged.indexOf(p) === i);
}

/**
 * PNG bytes for an in-memory image on the pasteboard.
 * Prefers a native public.png flavor; falls back to converting public.tiff, which is
 * the only flavor many apps (and NSImage writers) put on the pasteboard.
 */
function pngData(pb) {
  const png = pb.dataForType($.NSPasteboardTypePNG);
  if (!png.isNil()) return png;

  const tiff = pb.dataForType($.NSPasteboardTypeTIFF);
  if (tiff.isNil()) return null;

  const rep = $.NSBitmapImageRep.imageRepWithData(tiff);
  if (rep.isNil()) return null;
  const converted = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
  return converted.isNil() ? null : converted;
}

function run(argv) {
  try {
    const outDir = argv[0] || '/tmp';
    const pb = $.NSPasteboard.generalPasteboard;

    const paths = fileUrlPaths(pb);
    if (paths.length > 0) return JSON.stringify({ kind: 'files', paths: paths });

    const png = pngData(pb);
    if (png !== null) {
      // changeCount makes the staging name stable per clipboard state, so repeated
      // pastes of the same screenshot reuse one file instead of piling up.
      const dest = outDir + '/clip2remote-pb-' + pb.changeCount + '.png';
      $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(
        $(outDir), true, $(), $()
      );
      if (!png.writeToFileAtomically($(dest), true)) {
        return JSON.stringify({ kind: 'error', message: 'failed to write ' + dest });
      }
      return JSON.stringify({ kind: 'image', paths: [dest] });
    }

    return JSON.stringify({ kind: 'other', types: ObjC.deepUnwrap(pb.types) });
  } catch (e) {
    return JSON.stringify({ kind: 'error', message: String(e) });
  }
}
