import { test, expect } from '@playwright/test';
import { GatePage } from './pages/GatePage';

test.describe('Ticket Checking Gate App (/gate)', () => {
  test.beforeEach(async ({ page }) => {
    // Mock catalogue to provide a stable show option
    await page.route('**/api/catalogue', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          shows: [
            {
              id: 'show-2026-12-19',
              title: 'Opening Play - Samatat Natyomela',
              starts_at: '2026-12-19T18:00:00.000Z',
            },
          ],
        }),
      });
    });
  });

  test('should display gate scanning interface with show selected', async ({ page }) => {
    const gatePage = new GatePage(page);
    await gatePage.goto();

    await expect(gatePage.tokenInput).toBeVisible();
    await expect(gatePage.scanButton).toBeVisible();
    await expect(gatePage.cameraButton).toBeVisible();
  });

  test('should successfully admit a valid ticket token on first scan', async ({ page }) => {
    // Intercept scan endpoint to simulate valid admission
    await page.route('**/api/admission/scan', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          result: 'ADMITTED',
          receiptId: 'adm-receipt-12345',
        }),
      });
    });

    const gatePage = new GatePage(page);
    await gatePage.goto();
    await gatePage.scanToken('valid-crypto-ticket-token-001');

    await gatePage.expectAdmitted();
    await expect(page.locator('text=adm-receipt-12345')).toBeVisible();

    // Click next guest resets the view
    await gatePage.clickNext();
    await expect(gatePage.tokenInput).toBeVisible();
  });

  test('should reject already used ticket with DENIED alert on duplicate scan', async ({ page }) => {
    // Intercept scan endpoint to simulate already admitted ticket
    await page.route('**/api/admission/scan', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          result: 'DENIED',
          reason: 'Ticket already admitted for this show.',
        }),
      });
    });

    const gatePage = new GatePage(page);
    await gatePage.goto();
    await gatePage.scanToken('used-ticket-token-999');

    await gatePage.expectDenied(/Ticket already admitted for this show/i);
  });

  test('should handle unauthorized gatekeeper attempt (401/403)', async ({ page }) => {
    await page.route('**/api/admission/scan', async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Staff not authorized for this show, gate, or device.',
        }),
      });
    });

    const gatePage = new GatePage(page);
    await gatePage.goto();
    await gatePage.scanToken('ticket-token-test');

    await gatePage.expectDenied(/Staff not authorized/i);
  });
});
