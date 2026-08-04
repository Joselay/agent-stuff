---
name: frontend-design
description: Frontend art direction for building or substantially reshaping an interface. Use when a UI needs a distinctive visual concept, subject-specific typography, palette, layout, motion, or a polished implementation rather than routine component work.
---

# Frontend Art Direction

Act as an art director, then an implementer. Build a **subject-native** visual system: its choices should feel inevitable for this product and implausible for an unrelated one. Concentrate boldness in one **signature**—the memorable interaction, composition, or typographic move that carries the concept—then keep its surroundings disciplined.

## 1. Frame the brief

Inspect the product, existing UI, assets, and technical constraints. Identify:

- subject and audience
- the screen's single job
- required content and interactions
- brand or system constraints worth preserving

When the brief leaves the subject open, choose a concrete one and state it. Use real or credible subject matter throughout.

**Complete when:** one sentence names the subject, audience, job, and design opportunity without relying on generic style adjectives.

## 2. Establish art direction

Mine the subject's materials, tools, artifacts, environments, and vernacular. Explore at least two materially different concepts, then choose one. Define a compact system:

- **Concept:** one sentence linking the subject to the visual treatment
- **Palette:** 4–6 named color tokens with hex values and roles
- **Type:** display, body, and utility roles; specify family, weight, scale, and spacing
- **Composition:** grid, density, rhythm, and responsive transformation; use a small ASCII thumbnail when layout is non-obvious
- **Signature:** one subject-specific focal move and why it earns attention
- **Motion:** one orchestrated moment, or a stated reason the concept is stronger while still

Typography carries personality; structure carries meaning. Labels, rules, numbering, and dividers must encode a real hierarchy or relationship. Match execution complexity to the concept: expressive directions need enough craft to feel complete; restrained directions need exact spacing, type, and alignment.

Run the **substitution test**: mentally replace the subject with an unrelated product. Revise every major choice that still fits unchanged. Follow explicit visual direction from the brief even when it resembles a common pattern.

**Complete when:** every major visual choice traces to the subject or a stated constraint, and the signature passes the substitution test.

## 3. Build from the system

Follow the chosen direction rather than improvising a second one in code. Reuse the project's stack and conventions; derive color, type, spacing, and motion from tokens. Resolve selector precedence deliberately.

Make the hero or primary region state the page's thesis through its strongest subject-native content. Give supporting regions quieter hierarchy. Use decoration only when it reinforces the concept. Include responsive behavior, keyboard focus, readable contrast, semantic structure, useful empty/error states, and reduced-motion treatment as part of the design—not as a later patch.

When inventing or revising interface copy, read [COPY.md](COPY.md) before implementation and apply it to every visible string.

**Complete when:** the implemented screen preserves the concept and hierarchy at desktop and mobile widths, and every interactive state is usable by keyboard and with reduced motion.

## 4. Critique the rendered result

Render the interface and inspect screenshots at representative desktop and mobile widths. Compare the result with the brief and art direction, checking:

- Is the thesis obvious before details?
- Does the signature dominate exactly once?
- Does type create hierarchy without decorative noise?
- Do wrapping, overflow, density, and touch targets hold at narrow widths?
- Are focus, hover, loading, empty, error, and reduced-motion states coherent?
- Which accessory can be removed?

Fix the issues found and render again. Repeat until the critique produces no unresolved issue that weakens the brief, usability, or signature.

**Complete when:** both viewport passes are clean and the final implementation can be explained through the original concept sentence.
