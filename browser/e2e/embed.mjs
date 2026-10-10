// From galaxy-visualizations/playwright.shared.mjs, which sat at that repo's root.

export async function embedVisualization(page, { src, id = "viz" } = {}) {
  await page.setContent(
    `<style>html,body{height:100%;margin:0}</style>` +
      `<iframe id="${id}" style="width:100%;height:100%;border:0" src="${src}"></iframe>`,
  );
  await page.evaluate((frameId) => {
    window.galaxyHostMessages = [];
    window.addEventListener("message", (event) => {
      if (event.data?.from !== "galaxy-visualization") {
        return;
      }
      const frame = document.getElementById(frameId);
      window.galaxyHostMessages.push({
        ...event.data,
        fromEmbeddedFrame: event.source === frame?.contentWindow,
      });
    });
  }, id);
  return page.frameLocator(`#${id}`);
}

export function galaxyMessages(page) {
  return page.evaluate(() => window.galaxyHostMessages || []);
}
