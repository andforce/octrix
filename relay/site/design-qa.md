# Design QA

## Evidence

- Source visual truth path: `/Users/wdy/.codex/generated_images/01a06c8f-7286-7311-b5c4-95fcafe91258/exec-d450edb6-bce2-4854-b037-09b3c635c7ab.png`
- Source pixels: `1434 x 1097`; intended desktop CSS viewport: `1440 x 1100`; treated as a 1x concept reference.
- Rendered implementation: `http://127.0.0.1:5174/`
- Implementation screenshot path: Codex in-app browser capture attached inline to the current task; the browser API did not expose a filesystem path.
- Implementation desktop capture: `1440 x 1100` CSS pixels at `devicePixelRatio = 1`, no density normalization required.
- Responsive capture: `390 x 844` CSS pixels; document `scrollWidth = 390`, so no horizontal overflow was present.
- State: public landing page, default light theme, no authentication.
- Browser console: checked from a fresh page load; no warnings or errors.
- Error overlay: absent.

## Full-view comparison evidence

The source and final browser render were reviewed at the same desktop viewport and default state. The final render preserves the selected direction's compact header, single-line editorial headline, right-aligned conversion copy, continuous dark Mac-to-Cloud-to-iPhone workflow, four-item proof rail, and immediately visible three-step installation path. The hierarchy and vertical density now track the selected reference without the original oversized title or large empty section gaps.

## Focused-region comparison evidence

The hero and workflow panel were reviewed as a focused region because they contain the most fidelity-sensitive typography, spacing, product UI, icons, dividers, and device proportions. The implementation uses the existing Manrope and Noto Sans SC stack, the source coral/navy/mint token family, Phosphor icons with a consistent stroke language, an inset iPhone surface, and readable Chinese mock content. No raster imagery was required by the selected direction; the visible product surfaces are semantic HTML UI rather than placeholder artwork.

## Comparison history

### Pass 1

- [P2] The first implementation forced the hero headline onto two lines and placed the workflow panel about one section-step lower than the source.
  - Fix: removed the forced line break, reduced hero top padding, rebalanced the introduction columns, and widened the landing grid.
- [P2] The first iPhone implementation was flush to the workflow edge instead of reading as the inset rounded device shown in the source.
  - Fix: added the inset device treatment, dark bezel, restrained radius, and dedicated surrounding navy space.
- [P2] The installation heading wrapped too early and weakened the compact lower rail.
  - Fix: reduced the heading scale and rebalanced the quick-start grid.

### Pass 2

- Post-fix desktop evidence shows the headline, workflow panel, proof rail, and installation row in the same viewport and proportions as the selected design direction.
- Post-fix mobile evidence shows a readable linear flow at `390 x 844` with no clipping or horizontal overflow.
- No actionable P0, P1, or P2 findings remain.

## Fidelity surfaces

- Fonts and typography: passed. Manrope and Noto Sans SC are retained; the hero is capped at 64px, body text remains 15-16px, and small product UI uses clear optical weight and hierarchy.
- Spacing and layout rhythm: passed. The hero begins directly below the compact navigation, the workflow is above the fold at desktop size, and section padding was reduced throughout the landing page.
- Colors and visual tokens: passed. Existing `#101727`, `#EF654C`, `#59D6BE`, and `#F6F7FB` tokens map closely to the selected source with accessible dark/light contrast.
- Image quality and asset fidelity: passed. The source direction contains product UI and standard interface icons rather than photographic or illustrative assets. Product UI is rendered sharply as HTML, and icons come from one production icon library.
- Copy and content: passed. The promise, security boundary, supported Agent count, and three-step setup flow stay within existing product claims.
- Icons: passed. Phosphor icons replace ad hoc arrow and status glyphs in the redesigned landing experience.
- Interactions: passed. Primary CTA navigates to `/start`, where the “从安装 Host，到第一条回复。” heading renders; existing login, dashboard, navigation, and anchor routes remain links.
- Accessibility: passed for this scope. Semantic headings, ordered lists, named navigation, labeled product flows, visible focus styling, and reduced-motion handling are preserved.
- Responsiveness: passed at desktop `1440 x 1100` and mobile `390 x 844`; no horizontal overflow was detected.

## Follow-up polish

- [P3] The center relay labels are intentionally smaller than the reference at narrower desktop widths so the continuous panel remains stable before the tablet breakpoint.

## Implementation checklist

- [x] Match the selected direction's hero hierarchy and density.
- [x] Implement the continuous Mac-to-Cloud-to-iPhone workflow.
- [x] Bring trust proof and first-run steps into the first viewport.
- [x] Preserve core routes and conversion actions.
- [x] Verify desktop and mobile rendering.
- [x] Run unit tests and production build.

final result: passed

---

# Installation Command Copy QA — 2026-09-04

## Evidence

- Source visual truth path: browser comment attachment for `https://octrix.work/start` (inline browser capture; no filesystem path was exposed).
- Source capture: `1172 x 1144` CSS viewport at `devicePixelRatio = 2`, public `/start` route, command loaded, before the copy control was added.
- Rendered implementation path: `http://127.0.0.1:8790/start` (inline Codex in-app browser capture; no filesystem path was exposed).
- Desktop implementation capture: `1172 x 1144` CSS viewport at `devicePixelRatio = 2`.
- Mobile implementation capture: `390 x 844` CSS viewport at `devicePixelRatio = 1`; document `scrollWidth = 390`.
- State: public installation guide with the Host install command loaded; default and copied-success interaction states were tested.
- Browser console: no warnings or errors from the `127.0.0.1:8790` preview.

## Full-view comparison evidence

The source capture and desktop implementation capture were reviewed together at the same viewport and route. The existing installation hierarchy, three-column step layout, command surface dimensions, typography, illustration, section rhythm, and surrounding copy remain unchanged. The new control occupies the trailing edge of the existing dark command surface without changing the section width or pushing adjacent content.

## Focused-region comparison evidence

The annotated command surface was reviewed as the focused region. The copy action uses the existing Phosphor icon set, dark navy surface tokens, seven-pixel inset spacing, and the command block's established radius and border language. The code remains horizontally scrollable independently of the fixed action. At `390 x 844`, the button remains fully visible and the document has no horizontal overflow.

## Findings

- No actionable P0, P1, or P2 fidelity issues remain.
- The button has a visible icon and text label, a global `:focus-visible` outline, a disabled loading state, a retry state, and a mint success state.
- Activating the control changed its accessible name from “复制安装命令” to “安装命令已复制” and announced the visible “已复制” status before automatically resetting.

## Comparison history

### Pass 1

- The first rendered implementation preserved the source layout at `1172 x 1144`; no P0/P1/P2 layout or styling mismatch was found.
- The mobile capture at `390 x 844` confirmed that the command text truncates within its own scroll area while the copy control remains reachable, with no page-level horizontal overflow.
- No visual fix iteration was required.

## Required fidelity surfaces

- Fonts and typography: passed. Existing Manrope, Noto Sans SC, and system monospace stacks, sizes, weights, wrapping, and hierarchy are unchanged.
- Spacing and layout rhythm: passed. The control is inset inside the original command surface and does not alter surrounding margins, grid tracks, or section spacing.
- Colors and visual tokens: passed. The default control uses the existing night palette; success uses the existing mint family; retry uses the existing coral family.
- Image quality and asset fidelity: passed. No raster assets were introduced or changed; the copy and success marks use the project's existing Phosphor icon library.
- Copy and content: passed. The installation command remains byte-for-byte identical to the value returned for the configured public URL; only “复制”, “已复制”, and “重试” interaction labels were added.

## Implementation checklist

- [x] Add a one-click copy action to the Host installation command.
- [x] Preserve independent horizontal scrolling for the long command.
- [x] Add loading, success, retry, hover, and focus behavior.
- [x] Verify desktop and mobile rendering.
- [x] Verify clipboard behavior, accessibility feedback, unit tests, and production build.

final result: passed
