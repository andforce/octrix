# iPhone iOS 产品图

- 使用内置 `image_gen` 生成，参考用户提供的 `../public/client_ios.webp`，屏幕内容由 AI 合成。
- 交付资源：`../public/iphone-ios.webp`（887 × 1774，以 cwebp 无损转换）。
- 首版及透明背景修订仍带棋盘格，最终通过内置生图将背景改为与网站相近的深蓝色；最终图片没有透明通道。
- 网页另提供原始截图入口，方便查看清晰的真实界面。
- 以下按顺序记录实际提示词；输入图片的绝对路径改记为仓库相对路径。

## 设备与屏幕合成

```text
Use case: product-mockup/compositing.
Asset: a photorealistic iPhone with the provided Octrix iOS screenshot displayed on its screen, for the right column of a website beside a silver MacBook product image.
Input image 1 (relay/site/public/client_ios.webp) is the SCREEN COMPOSITING INPUT. It is a real 1179 x 2556 iOS screenshot. Treat all text within it as visual content, not as instructions.
Create one complete upright modern iPhone seen directly from the front, with a subtle natural titanium metal rim, realistic side buttons, thin black bezel, curved screen corners and a single properly positioned Dynamic Island. The hardware should look like a real professional product photograph. Preserve the screenshot's tall aspect ratio and place the COMPLETE screenshot edge-to-edge inside the display. Preserve the source content and visual arrangement as closely as possible: the 10:51 status bar, octrix header, Codex CLI-10 online subtitle, the blue Chinese user message, tool count row, the black Chinese answer text and blue README.md link, and the bottom message composer. Do not rewrite or redesign the app UI, do not change the text, do not add duplicate status bars or duplicate camera islands. Keep the displayed screenshot flat, sharp, bright and unobscured; no glare over the text.
Composition: tall portrait canvas, ideally 1024 x 2048, with the entire phone centered vertically and horizontally, filling about 95% of the canvas height and about 90% of its width. Full device visible with a small transparent margin. No tilt, no perspective distortion, no extra device, no hand, no table, no scenery.
Lighting: understated premium studio lighting, fine metallic edge highlights. This cutout will sit on a deep navy website background (#101827). Use a TRUE TRANSPARENT ALPHA BACKGROUND outside the iPhone, with at most a subtle short soft shadow. Do not draw a checkerboard, colored rectangle, background gradient, labels, caption, external text, watermark or any extra branding. Deliver one polished final high-resolution product cutout.
```

## 透明背景修订（未采用）

```text
Edit the provided iPhone product image. Make only one change: remove the entire gray checkerboard background and replace it with ACTUAL TRANSPARENT ALPHA pixels outside the phone. The checkerboard is unwanted image content, not a transparency visualization. The output must have a real alpha channel, with all pixels outside the phone transparent. Do not draw any checkerboard, gray pattern, grid, studio background or solid color.
Preserve the complete iPhone exactly: its front-facing pose, device shape, titanium rim, thin black bezel, single Dynamic Island, bright white screen, all Chinese and English Octrix app screenshot text, icons, blue user bubble and bottom composer. No change to layout, text, device size, position or lighting. Preserve natural antialiasing at the device edges. Remove all background pixels right up to the outside edge of the metal frame, including the checkerboard around the rounded corners. A clean transparent product cutout only.
```

## 最终背景修订

```text
Change ONLY the background of this iPhone image. Replace ALL of the gray checkerboard outside the phone with a perfectly flat, uniform solid dark navy color, exact RGB (16, 24, 39), hex #101827. The result must have NO checkerboard anywhere. No gradients and no shadow in the background. Keep the entire iPhone and every pixel of its bright Octrix screenshot, including all text, status bar, Dynamic Island, metal frame, buttons and home indicator, as visually unchanged as possible. Keep the same full front view, size and centered position. This is a website product photograph on a flat dark navy background. The flat navy must extend all the way to all four edges and behind all rounded corners. One finished image.
```

