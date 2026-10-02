import { test, expect } from '@playwright/test';
import { CartPage } from './pages/CartPage';

test.describe('Cart Operations', () => {
  const sampleItems = [
    {
      productId: 'prod-premier-01',
      name: 'Premier Zone - Play 1',
      category: 'Premier',
      kind: 'DAILY',
      showTitle: 'Raja O Rani',
      startsAt: '2026-12-19T18:00:00.000Z',
      unitPrice: 30000,
      version: 1,
      quantity: 2,
    },
    {
      productId: 'prod-balcony-01',
      name: 'Balcony Zone - Play 1',
      category: 'Balcony',
      kind: 'DAILY',
      showTitle: 'Raja O Rani',
      startsAt: '2026-12-19T18:00:00.000Z',
      unitPrice: 10000,
      version: 1,
      quantity: 1,
    },
  ];

  test('should render empty cart notice when storage is empty', async ({ page }) => {
    const cartPage = new CartPage(page);
    await cartPage.goto();
    await expect(cartPage.emptyNotice).toBeVisible();
  });

  test('should load items from localStorage, show items and total', async ({ page }) => {
    const cartPage = new CartPage(page);
    await cartPage.seedCart(sampleItems);
    await cartPage.goto();

    await expect(cartPage.cartItems).toHaveCount(2);

    // Total should be (2 * 300) + (1 * 100) = 700
    await expect(cartPage.totalDisplay).toContainText('700');
  });

  test('should increase item quantity with stepper and update total', async ({ page }) => {
    const cartPage = new CartPage(page);
    await cartPage.seedCart(sampleItems);
    await cartPage.goto();

    // Increase second item quantity (from 1 to 2)
    await cartPage.clickIncrease(1);

    // Total should now be (2 * 300) + (2 * 100) = 800
    await expect(cartPage.totalDisplay).toContainText('800');
  });

  test('should enforce max tickets cap (6 tickets)', async ({ page }) => {
    const cartPage = new CartPage(page);
    // Already 3 tickets (2 + 1)
    await cartPage.seedCart(sampleItems);
    await cartPage.goto();

    // Increase up to max 6: click 3 times
    await cartPage.clickIncrease(1); // 4
    await cartPage.clickIncrease(1); // 5
    await cartPage.clickIncrease(1); // 6

    // Attempting to exceed 6 should show error notice
    await cartPage.clickIncrease(1); // 7 -> error
    await expect(page.locator('p[role="alert"]')).toBeVisible();
  });

  test('should remove item and update cart accordingly', async ({ page }) => {
    const cartPage = new CartPage(page);
    await cartPage.seedCart(sampleItems);
    await cartPage.goto();

    // Remove first item
    await cartPage.removeItem(0);

    await expect(cartPage.cartItems).toHaveCount(1);
    await expect(cartPage.totalDisplay).toContainText('100');
  });
});
