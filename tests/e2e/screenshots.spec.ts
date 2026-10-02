import { test } from '@playwright/test';

test('capture current UI screenshots', async ({ page }) => {
  // Mobile viewport
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'artifacts/screenshot-home-mobile.png', fullPage: true });

  await page.goto('/catalogue');
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'artifacts/screenshot-catalogue-mobile.png', fullPage: true });

  await page.goto('/cart');
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'artifacts/screenshot-cart-mobile.png', fullPage: true });

  await page.goto('/gate');
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'artifacts/screenshot-gate-mobile.png', fullPage: true });

  // Desktop viewport
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'artifacts/screenshot-home-desktop.png', fullPage: true });

  await page.goto('/catalogue');
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'artifacts/screenshot-catalogue-desktop.png', fullPage: true });
});
