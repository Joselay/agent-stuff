---
name: "imagegen"
description: "Generate or edit raster images when the task benefits from AI-created bitmap visuals such as photos, illustrations, textures, sprites, mockups, or transparent-background cutouts. Use when Pi should create a brand-new image, transform an existing image, or derive visual variants from references, and the output should be a bitmap asset rather than repo-native code or vector. Do not use when the task is better handled by editing existing SVG/vector/code-native assets, extending an established icon or logo system, or building the visual directly in HTML/CSS/canvas."
---

# Image Generation Skill

Generates or edits images for the current project (for example website assets, game assets, UI mockups, product mockups, wireframes, logo design, photorealistic images, or infographics).

## Top-level modes and rules

This skill has exactly one top-level mode:

- **Default Pi imagegen tool mode:** Pi `imagegen` tool for normal image generation, editing, and simple transparent-image requests.

Rules:
- Use the Pi `imagegen` tool by default for normal image generation and editing requests.
- If the user explicitly asks for a transparent image/background, stay on Pi `imagegen`: prompt for a flat removable chroma-key background, then remove it locally with the installed helper at `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/skills/imagegen/scripts/remove_chroma_key.py`.
- The word `batch` by itself does not change the execution path. If the user asks for many assets or says to batch-generate assets, stay on the Pi imagegen path and issue one `imagegen` call per requested asset or variant.

Pi imagegen save-path policy:
- In Pi imagegen tool mode, Pi saves generated images under `$PI_CODING_AGENT_DIR/generated_images/...` by default.
- Do not describe or rely on OS temp as the default Pi imagegen destination.
- Do not describe or rely on a destination-path argument (if any) on the Pi `imagegen` tool. If a specific location is needed, generate first and then move or copy the selected output from `$PI_CODING_AGENT_DIR/generated_images/...`.
- Save-path precedence in Pi imagegen mode:
  1. If the user names a destination, move or copy the selected output there.
  2. If the image is meant for the current project, move or copy the final selected image into the workspace before finishing.
  3. If the image is only for preview or brainstorming, render it inline; the underlying file can remain at the default `$PI_CODING_AGENT_DIR/*` path.
- Never leave a project-referenced asset only at the default `$PI_CODING_AGENT_DIR/*` path.
- Do not overwrite an existing asset unless the user explicitly asked for replacement; otherwise create a sibling versioned filename such as `hero-v2.png` or `item-icon-edited.png`.

Shared prompt guidance lives in `references/prompting.md` and `references/sample-prompts.md`.

Local post-processing helper:
- `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/skills/imagegen/scripts/remove_chroma_key.py`: removes a flat chroma-key background from a generated image and writes a PNG/WebP with alpha. Prefer auto-key sampling, soft matte, and despill for antialiased edges.

Local helper dependencies:
- Prefer `uv` for dependency management in this repo.
- Required for local chroma-key removal and optional downscaling:
  ```bash
  uv pip install pillow
  ```
- If you are using the installed skill outside this repo, install dependencies into that environment with its package manager.
- In uv-managed environments, `uv pip install ...` remains the preferred path.
- If installation is not possible in this environment, tell the user which dependency is missing and how to install it into their active environment.

## When to use
- Generate a new image (concept art, product shot, cover, website hero)
- Generate a new image using one or more reference images for style, composition, or mood
- Edit an existing image (inpainting, lighting or weather transformations, background replacement, object removal, compositing, transparent background)
- Produce many assets or variants for one task

## When not to use
- Extending or matching an existing SVG/vector icon set, logo system, or illustration library inside the repo
- Creating simple shapes, diagrams, wireframes, or icons that are better produced directly in SVG, HTML/CSS, or canvas
- Making a small project-local asset edit when the source file already exists in an editable native format
- Any task where the user clearly wants deterministic code-native output instead of a generated bitmap

## Decision tree

Think about two separate questions:

1. **Intent:** is this a new image or an edit of an existing image?
2. **Execution strategy:** is this one asset or many assets/variants?

Intent:
- If the user wants to modify an existing image while preserving parts of it, treat the request as **edit**.
- If the user provides images only as references for style, composition, mood, or subject guidance, treat the request as **generate**.
- If the user provides no images, treat the request as **generate**.

Pi imagegen edit semantics:
- Pi imagegen edit mode is for images already visible in the conversation context, such as attached images or images generated earlier in the thread.
- If the user wants to edit a local image file with the Pi `imagegen` tool, first load it with the `read` tool so the image is visible in the conversation context, then proceed with the Pi imagegen edit flow.
- Do not promise arbitrary filesystem-path editing through the Pi `imagegen` tool.
- If a local file needs masks or direct parameters that `imagegen` does not expose, explain the limitation instead of switching execution paths.
- For edits, preserve invariants aggressively and save non-destructively by default.

Execution strategy:
- In the Pi imagegen default path, produce many assets or variants by issuing one `imagegen` call per requested asset or variant.
- For many distinct assets, do not use `n` as a substitute for separate prompts. `n` is for variants of one prompt; distinct assets need distinct `imagegen` calls.

Assume the user wants a new image unless they clearly ask to change an existing one.

## Workflow
1. Decide the intent: `generate` or `edit`.
2. Decide whether the output is preview-only or meant to be consumed by the current project.
3. Decide the execution strategy: single asset vs repeated `imagegen` calls.
4. Collect inputs up front: prompt(s), exact text (verbatim), constraints/avoid list, and any input images.
5. For every input image, label its role explicitly:
   - reference image
   - edit target
   - supporting insert/style/compositing input
6. If the edit target is only on the local filesystem and you are staying on the Pi imagegen path, inspect it with `read` first so the image is available in conversation context.
7. If the user asked for a photo, illustration, sprite, product image, banner, or other explicitly raster-style asset, use `imagegen` rather than substituting SVG/HTML/CSS placeholders. If the request is for an icon, logo, or UI graphic that should match existing repo-native SVG/vector/code assets, prefer editing those directly instead.
8. Augment the prompt based on specificity:
   - If the user's prompt is already specific and detailed, normalize it into a clear spec without adding creative requirements.
   - If the user's prompt is generic, add tasteful augmentation only when it materially improves output quality.
9. Use the Pi `imagegen` tool by default.
10. For transparent-output requests, follow the transparent image guidance below: generate with Pi `imagegen` on a flat chroma-key background, copy the selected output into the workspace or `tmp/imagegen/`, run the installed `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/skills/imagegen/scripts/remove_chroma_key.py` helper, and validate the alpha result before using it. If this path looks unsuitable or fails, explain the limitation and ask how the user wants to proceed.
11. Inspect outputs and validate: subject, style, composition, text accuracy, and invariants/avoid items.
12. Iterate with a single targeted change, then re-check.
13. For preview-only work, render the image inline; the underlying file may remain at the default `$PI_CODING_AGENT_DIR/generated_images/...` path.
14. For project-bound work, move or copy the selected artifact into the workspace and update any consuming code or references. Never leave a project-referenced asset only at the default `$PI_CODING_AGENT_DIR/generated_images/...` path.
15. For batches or multi-asset requests, persist every requested deliverable final in the workspace unless the user explicitly asked to keep outputs preview-only. Discarded variants do not need to be kept unless requested.
16. Always report the final saved path(s) for any workspace-bound asset(s), plus the final prompt or prompt set and that Pi `imagegen` was used.

## Transparent image requests

Transparent-image requests still use Pi `imagegen` first. Because the Pi `imagegen` tool does not expose a true transparent-background control, create a removable chroma-key source image and then convert the key color to alpha locally.

Default sequence:
1. Use Pi `imagegen` to generate the requested subject on a perfectly flat solid chroma-key background.
2. Choose a key color that is unlikely to appear in the subject: default `#00ff00`, use `#ff00ff` for green subjects, and avoid `#0000ff` for blue subjects.
3. After generation, move or copy the selected source image from `$PI_CODING_AGENT_DIR/generated_images/...` into the workspace or `tmp/imagegen/`.
4. Use `tmp/imagegen/` for intermediate chroma-key files when the final destination is not known yet; delete unnecessary intermediates when done.
5. Run the installed helper path, not a project-relative script path:
   ```bash
   python "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/skills/imagegen/scripts/remove_chroma_key.py" \
     --input <source> \
     --out <final.png> \
     --auto-key border \
     --soft-matte \
     --transparent-threshold 12 \
     --opaque-threshold 220 \
     --despill
   ```
6. Validate that the output has an alpha channel, transparent corners, plausible subject coverage, and no obvious key-color fringe. If a thin fringe remains, retry once with `--edge-contract 1`; use `--edge-feather 0.25` only when the edge is visibly stair-stepped and the subject is not shiny or reflective.
7. Save the final alpha PNG/WebP in the project if the asset is project-bound. Never leave a project-referenced transparent asset only under `$PI_CODING_AGENT_DIR/*`.

Prompt transparent requests like this:

```text
Create the requested subject on a perfectly flat solid #00ff00 chroma-key background for background removal.
The background must be one uniform color with no shadows, gradients, texture, reflections, floor plane, or lighting variation.
Keep the subject fully separated from the background with crisp edges and generous padding.
Do not use #00ff00 anywhere in the subject.
No cast shadow, no contact shadow, no reflection, no watermark, and no text unless explicitly requested.
```

If the user asks for true/native transparency, local removal fails validation, or the requested image is complex (hair, fur, feathers, smoke, glass, liquids, translucent materials, reflective objects, soft shadows, realistic product grounding, or subject colors that conflict with all practical key colors), explain the chroma-key limitation and ask how the user wants to proceed.

## Prompt augmentation

Reformat user prompts into a structured, production-oriented spec. Make the user's goal clearer and more actionable, but do not blindly add detail.

Treat this as prompt-shaping guidance, not a closed schema. Use only the lines that help, and add a short extra labeled line when it materially improves clarity.

### Specificity policy

Use the user's prompt specificity to decide how much augmentation is appropriate:

- If the prompt is already specific and detailed, preserve that specificity and only normalize/structure it.
- If the prompt is generic, you may add tasteful augmentation when it will materially improve the result.

Allowed augmentations:
- composition or framing hints
- polish level or intended-use hints
- practical layout guidance
- reasonable scene concreteness that supports the stated request

Not allowed augmentations:
- extra characters or objects that are not implied by the request
- brand names, slogans, palettes, or narrative beats that are not implied
- arbitrary side-specific placement unless the surrounding layout supports it

## Use-case taxonomy (exact slugs)

Classify each request into one of these buckets and keep the slug consistent across prompts and references.

Generate:
- photorealistic-natural — candid/editorial lifestyle scenes with real texture and natural lighting.
- product-mockup — product/packaging shots, catalog imagery, merch concepts.
- ui-mockup — app/web interface mockups and wireframes; specify the desired fidelity.
- infographic-diagram — diagrams/infographics with structured layout and text.
- scientific-educational — classroom explainers, scientific diagrams, and learning visuals with required labels and accuracy constraints.
- ads-marketing — campaign concepts and ad creatives with audience, brand position, scene, and exact tagline/copy.
- productivity-visual — slide, chart, workflow, and data-heavy business visuals.
- logo-brand — logo/mark exploration, vector-friendly.
- illustration-story — comics, children’s book art, narrative scenes.
- stylized-concept — style-driven concept art, 3D/stylized renders.
- historical-scene — period-accurate/world-knowledge scenes.

Edit:
- text-localization — translate/replace in-image text, preserve layout.
- identity-preserve — try-on, person-in-scene; lock face/body/pose.
- precise-object-edit — remove/replace a specific element (including interior swaps).
- lighting-weather — time-of-day/season/atmosphere changes only.
- background-extraction — transparent background / clean cutout. Use Pi `imagegen` with chroma-key removal for simple opaque subjects; ask how to proceed for complex subjects.
- style-transfer — apply reference style while changing subject/scene.
- compositing — multi-image insert/merge with matched lighting/perspective.
- sketch-to-render — drawing/line art to photoreal render.

## Shared prompt schema

Use the following labeled spec as shared prompt scaffolding:

```text
Use case: <taxonomy slug>
Asset type: <where the asset will be used>
Primary request: <user's main prompt>
Input images: <Image 1: role; Image 2: role> (optional)
Scene/backdrop: <environment>
Subject: <main subject>
Style/medium: <photo/illustration/3D/etc>
Composition/framing: <wide/close/top-down; placement>
Lighting/mood: <lighting + mood>
Color palette: <palette notes>
Materials/textures: <surface details>
Text (verbatim): "<exact text>"
Constraints: <must keep/must avoid>
Avoid: <negative constraints>
```

Notes:
- `Asset type` and `Input images` are prompt scaffolding, not tool arguments.
- `Scene/backdrop` refers to the visual setting. It is not a tool parameter.
- Do not treat `Quality:`, `Input fidelity:`, masks, output format, or output paths as Pi `imagegen` tool arguments.

Augmentation rules:
- Keep it short.
- Add only the details needed to improve the prompt materially.
- For edits, explicitly list invariants (`change only X; keep Y unchanged`).
- If any critical detail is missing and blocks success, ask a question; otherwise proceed.

## Examples

### Generation example (hero image)
```text
Use case: product-mockup
Asset type: landing page hero
Primary request: a minimal hero image of a ceramic coffee mug
Style/medium: clean product photography
Composition/framing: wide composition with usable negative space for page copy if needed
Lighting/mood: soft studio lighting
Constraints: no logos, no text, no watermark
```

### Edit example (invariants)
```text
Use case: precise-object-edit
Asset type: product photo background replacement
Primary request: replace only the background with a warm sunset gradient
Constraints: change only the background; keep the product and its edges unchanged; no text; no watermark
```

## Prompting best practices
- Structure prompt as scene/backdrop -> subject -> details -> constraints.
- Include intended use (ad, UI mock, infographic) to set the mode and polish level.
- Use camera/composition language for photorealism.
- Only use SVG/vector stand-ins when the user explicitly asked for vector output or a non-image placeholder.
- Quote exact text and specify typography + placement.
- For tricky words, spell them letter-by-letter and require verbatim rendering.
- For multi-image inputs, reference images by index and describe how they should be used.
- For edits, repeat invariants every iteration to reduce drift.
- Iterate with single-change follow-ups.
- If the prompt is generic, add only the extra detail that will materially help.
- If the prompt is already detailed, normalize it instead of expanding it.
- For transparent images, use the Pi imagegen chroma-key workflow; if the request is too complex for clean local removal, explain the limitation and ask how to proceed.

More principles: `references/prompting.md`.
Copy/paste specs: `references/sample-prompts.md`.

## Guidance by asset type
Asset-type templates (website assets, game assets, wireframes, logo) are consolidated in `references/sample-prompts.md`.

## gpt-image-2 note

The Pi imagegen path uses `gpt-image-2` with automatic background, quality, and size settings. The `imagegen` tool does not expose quality, size, masks, output format, or output-path parameters; focus on prompt quality and post-processing instead.

## Reference map
- `references/prompting.md`: prompting principles.
- `references/sample-prompts.md`: copy/paste prompt recipes.
- `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/skills/imagegen/scripts/remove_chroma_key.py`: local post-processing helper for transparent-image requests.
