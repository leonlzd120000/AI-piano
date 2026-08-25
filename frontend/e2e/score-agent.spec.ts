import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

const samplePath = (filename: string) =>
  resolve(process.cwd(), "../backend/sample_scores", filename);

async function expectRenderedPdf(page: import("@playwright/test").Page) {
  const preview = page.locator(".pdf-canvas-preview");
  await expect(preview).toBeVisible({ timeout: 120000 });

  const firstPage = preview.locator("canvas").first();
  await expect(firstPage).toHaveAttribute("data-rendered", "true", {
    timeout: 120000
  });

  const pixels = await firstPage.evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return { dark: 0, pink: 0, blue: 0 };

    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let dark = 0;
    let pink = 0;
    let blue = 0;
    for (let offset = 0; offset < data.length; offset += 16) {
      const red = data[offset];
      const green = data[offset + 1];
      const blueChannel = data[offset + 2];
      if (red < 180 && green < 180 && blueChannel < 180) dark += 1;
      if (red > 120 && green < 120 && blueChannel > 80 && red > blueChannel) {
        pink += 1;
      }
      if (blueChannel > 120 && blueChannel > red * 1.4 && blueChannel > green * 1.4) {
        blue += 1;
      }
    }
    return { dark, pink, blue };
  });

  expect(pixels.dark).toBeGreaterThan(100);
  expect(pixels.pink).toBeGreaterThan(10);
  expect(pixels.blue).toBeGreaterThan(10);
}

async function expectPianoLabelsAligned(page: import("@playwright/test").Page) {
  const labels = page.locator(".piano-key-label");
  expect(await labels.count()).toBeGreaterThan(0);

  const alignment = await labels.evaluateAll((elements) =>
    elements.map((element) => {
      const midi = element.getAttribute("data-midi");
      const key = document.querySelector(
        `.piano-key.is-highlighted[data-midi="${midi}"]`
      );
      const labelBox = element.getBoundingClientRect();
      const keyBox = key?.getBoundingClientRect();
      return {
        note: element.textContent,
        centerDelta: keyBox
          ? Math.abs(
              labelBox.left +
                labelBox.width / 2 -
                (keyBox.left + keyBox.width / 2)
            )
          : Number.POSITIVE_INFINITY,
        isAbove: Boolean(keyBox && labelBox.bottom <= keyBox.top)
      };
    })
  );

  expect(alignment.every(({ note }) => /^[A-G](?:b|#)*$/.test(note ?? ""))).toBe(
    true
  );
  expect(alignment.every(({ centerDelta }) => centerDelta < 2)).toBe(true);
  expect(alignment.every(({ isAbove }) => isAbove)).toBe(true);
}

test("loads the sample score and reruns with octave labels", async ({ page }) => {
  test.setTimeout(300000);
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  await page.goto("/");
  await expectRenderedPdf(page);
  await expect(page.getByText("右手", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("左手", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "下载标注 PDF" })).toBeEnabled();

  await page.getByRole("button", { name: "字母 + 八度" }).click();
  await page.getByRole("button", { name: "重新标注" }).click();

  await expectRenderedPdf(page);
  await expect(
    page.getByText(/组标注均已写入 MusicXML，\d+\/\d+ 个识别音符已写入原版式 PDF/)
  ).toBeVisible();
  await expect(page.getByText("小节练习")).toBeVisible();
  await expect(page.getByRole("button", { name: "右手" })).toHaveClass(/is-active/);
  expect(await page.locator(".piano-key.is-highlighted").count()).toBeGreaterThan(0);
  await expectPianoLabelsAligned(page);

  await page.getByRole("button", { name: "左手" }).click();
  await expect(page.getByRole("button", { name: "左手" })).toHaveClass(/is-active/);
  expect(await page.locator(".piano-key.is-highlighted").count()).toBeGreaterThan(0);
  await expectPianoLabelsAligned(page);

  await page.screenshot({
    path: "/tmp/music-score-agent-interaction.png",
    fullPage: false
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await expectRenderedPdf(page);
  const previewBox = await page.locator(".pdf-canvas-preview").boundingBox();
  expect(previewBox).not.toBeNull();
  expect(previewBox!.x).toBeGreaterThanOrEqual(0);
  expect(previewBox!.x + previewBox!.width).toBeLessThanOrEqual(390);
  await page.locator(".score-pdf-page").first().scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "/tmp/music-score-agent-mobile.png",
    fullPage: false
  });

  expect(consoleErrors).toEqual([]);
});

test("annotates scanned image and PDF scores through OMR", async ({ page }) => {
  test.setTimeout(300000);

  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  await page.goto("/");
  await expectRenderedPdf(page);

  const fileInput = page.locator('input[type="file"]');

  await fileInput.setInputFiles(samplePath("c-major-scan.png"));
  await expect(page.getByTitle("c-major-scan.png")).toBeVisible();
  await page.getByRole("button", { name: "开始标注" }).click();

  await expect(page.getByText("光学识谱")).toBeVisible();
  await expect(page.getByText("HOMR 已识别 1 页图像并转换为 MusicXML")).toBeVisible({
    timeout: 60000
  });
  await expect(page.locator(".agent-note-label")).toHaveCount(12);
  await expect(page.getByText("homr-0.7.0 · 1 页")).toBeVisible();

  await fileInput.setInputFiles(samplePath("c-major-scan.pdf"));
  await expect(page.getByTitle("c-major-scan.pdf")).toBeVisible();
  await page.getByRole("button", { name: "开始标注" }).click();

  await expect(page.getByText(/HOMR 已识别 1 页图像并转换为 MusicXML，PDF 已定位 \d+\/\d+ 个音符/)).toBeVisible({
    timeout: 60000
  });
  await expectRenderedPdf(page);
  await expect(page.getByText("c-major-scan.pdf").first()).toBeVisible();
  await expect(page.getByText("homr-0.7.0 · 1 页")).toBeVisible();
  await expect(page.getByRole("button", { name: "下载标注 PDF" })).toBeEnabled();

  expect(consoleErrors).toEqual([]);
});
