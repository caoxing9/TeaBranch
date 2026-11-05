import { expect, open, test } from "nsh/test";

test("the window opens on the issues section and reaches autopilot's home", async () => {
  const app = await open("./App.tsx");
  await app.waitFor("text:Issues", { timeout: 15_000 });
  expect(app.texts()).toContain("登录 Teable");
  await app.press("text:托管");
  await app.waitFor("text:总览", { timeout: 15_000 });
  expect(app.texts()).toContain("新探查");
});
