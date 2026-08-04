---
name: imagegen
description: "Generate and edit AI raster images—photos, illustrations, textures, sprites, mockups, transparent cutouts, and reference-guided variants—when the deliverable is a bitmap. Route repo-native SVG/vector, existing-system icons or logos, and HTML/CSS/canvas visuals to native code instead."
---

# Image Generation Skill

Route every AI raster generation and edit through `scripts/imagegen.mjs`. Proceed without reconfirmation once all required inputs are readable.

## Rules

- OAuth is the only credential. On an auth failure, ask the user to run `/login`. Leave authentication storage untouched and undisclosed; use no API key, alternate provider, or one-off SDK runner.
- The helper is pinned to the upstream built-in `image_gen` request shape: `model: "gpt-image-2"`, `background`/`quality`/`size` set to `"auto"`, one result, up to five high-fidelity input images. Treat these controls and `scripts/imagegen.mjs` as fixed during image tasks; explain unavailable capabilities.
- Reserve Python for local post-processing such as chroma-key removal. Run Python helpers with `uv run --with Pillow`; perform generative edits through `imagegen.mjs`.
- Issue one tailored helper call per requested asset or variant, with a distinct prompt per deliverable.
- Return the generated bitmap for every raster request.

## Workflow

1. Classify each deliverable as **edit** when an existing image must change while preserving parts of it; classify images used only for style, composition, or mood as references to a **generate** request. Default to generate. Finish when every deliverable has one classification.
2. Collect prompt(s), verbatim text, constraints, and input images. Inspect every input with `read`, then assign its index and role (`Image 1: edit target; Image 2: style reference`). A mentioned filename becomes an input only when passed with `--input`. Finish when every required input is present, readable, and assigned exactly one role; otherwise ask for the missing attachment.
3. Before every helper call, load `references/prompting.md` and turn the request into its prescribed creative brief. For edits, state the change and all invariants explicitly (`change only X; keep Y unchanged`). Finish when every user requirement is accounted for in the brief.
4. Run the helper. Use `--prompt-file` for long prompts, `--input` once per input image, and at least a 180-second timeout.
5. Inspect every output with `read`. Check every requested subject, style, composition, text, and edit invariant. If any check fails, make one targeted revision per call and restate all invariants. Finish when every requirement visibly passes or a model limitation is identified for the user.
6. Apply the save-path policy and update all consuming code for project-bound assets. Finish when every selected bitmap has a stable destination and every project reference resolves to it.
7. Report final path(s), prompt(s), and any unresolved limitation.

## Helper

Generate:

```bash
node <skill-directory>/scripts/imagegen.mjs --prompt "<complete prompt>"
```

Edit or use references:

```bash
node <skill-directory>/scripts/imagegen.mjs \
  --prompt "<complete prompt with indexed roles and invariants>" \
  --input "<absolute-image-1>" \
  --input "<absolute-image-2>"
```

The helper prints the saved path under `~/.pi/generated_images/`.

## Save-path policy

- Every output lands under `~/.pi/generated_images/` with a unique per-call name.
- If the user names a destination, copy the selected output there. If the image is for the current project, copy it into the workspace before finishing. Preview-only images may stay at the default path. A project-referenced asset must never live only under `~/.pi/generated_images/`.
- When copying, leave the original in place unless the user explicitly asks to delete it.
- Save as a sibling versioned filename (`hero-v2.png`, `item-icon-edited.png`); overwrite an existing asset only when the user explicitly asks for replacement.

## Transparent images

For every transparent background, cutout, or alpha PNG request, load and complete `references/transparency.md`: chroma-key generation, local key-to-alpha conversion, and alpha validation.

## References

- `references/sample-prompts.md` — copy/paste prompt recipes plus asset-type templates (website, game, wireframe, logo).
