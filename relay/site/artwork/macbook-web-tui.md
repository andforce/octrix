# MacBook Web TUI 产品图

- 使用内置 `image_gen` 生成，参考用户提供的 `../public/client_web.webp`，屏幕内容由 AI 合成。
- 交付资源：`../public/macbook-web-tui.webp`（1536 × 1024，保留透明通道，以 cwebp 无损转换）。
- 网页另提供原始截图入口，方便查看清晰的真实界面。
- 以下为生成提示词；输入图片的绝对路径改记为仓库相对路径。

```text
Use case: product-mockup / compositing.
Asset type: a production website hero illustration showing a real MacBook running Octrix's Mac Web TUI.
Input image: relay/site/public/client_web.webp is the exact screenshot to insert into the laptop screen, not a style reference.
Create one photorealistic silver aluminum MacBook laptop, open, fully visible, centered, almost straight-on with a very slight elevated viewing angle so the keyboard and trackpad are recognizably visible. The screen should remain close to a frontal rectangle, with minimal perspective distortion. The laptop must look like a physical Apple MacBook with slim black bezel and realistic brushed aluminum, carefully proportioned keyboard, trackpad, hinge and thin front edge.
Place the supplied client_web.webp screenshot edge-to-edge inside the display. Preserve the entire screenshot including the Safari browser toolbar, three-column Octrix interface, sidebar, dark chat area, code blocks, and workspace file tree. Keep its layout, original content, colors and all visible Chinese and English text as faithfully as possible; do not invent a new app, replace it with an abstract UI, add code, or enlarge/redesign portions. No glare should obscure the screen.
Composition: landscape 3:2 canvas, high resolution, entire laptop including all corners and front edge comfortably inside frame, laptop fills about 94% of the width. Premium clean studio product rendering with softly lit silver edges that remain legible over a dark navy website panel (#101827).
Background: genuinely transparent alpha background, including between and around device edges, with only a subtle soft contact shadow. No solid white/gray background and no checkerboard pattern. No people, desks, props, decorative graphics, external labels, titles, extra brand marks or watermark. Generate only this single laptop product asset.
```
