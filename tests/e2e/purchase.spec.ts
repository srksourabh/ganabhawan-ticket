import { test, expect } from '@playwright/test';
import { BookingPage } from './pages/BookingPage';
import { CartPage } from './pages/CartPage';

test.describe('Ticket Purchase & Checkout Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.context().addCookies([
      { name: 'samatat-locale', value: 'en', domain: 'localhost', path: '/' },
    ]);

    // Mock catalogue API
    await page.route('**/api/catalogue', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          products: [
            {
              id: 'prod-premier-day1',
              name: 'Premier Section',
              name_bn: 'প্ৰিমিয়াৰ শাখা',
              category: 'Premier',
              kind: 'DAILY',
              price: 30000,
              version: 1,
              coverage: [
                {
                  title: 'Opening Play',
                  title_bn: 'উদ্বোধনী নাটক',
                  starts_at: '2026-12-19T18:00:00.000Z',
                },
              ],
            },
          ],
        }),
      });
    });

    // Mock booking-attempts API
    await page.route('**/api/booking-attempts', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'att-12345' }),
      });
    });
  });

  test('should allow selecting ticket, entering buyer details, and adding to cart', async ({ page }) => {
    const bookingPage = new BookingPage(page);
    await bookingPage.goto('prod-premier-day1');

    await bookingPage.fillBuyerDetails('Sourav Kumar', '9876543210', 2);
    await bookingPage.addToCart();

    await expect(bookingPage.successBanner).toBeVisible();
    await expect(bookingPage.reserveButton).toBeVisible();
  });

  test('should navigate to cart and checkout successfully with simulated order and payment', async ({ page }) => {
    // Mock user auth
    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          contact: '9876543210',
          name: 'Sourav Kumar',
          role: 'customer',
        }),
      });
    });

    // Mock holds API
    await page.route('**/api/holds', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'booking-999',
          reference: 'SAM-2026-999',
          total: 60000,
          currency: 'INR',
          unit_price: 30000,
          quantity: 2,
          expires_at: new Date(Date.now() + 600000).toISOString(),
        }),
      });
    });

    // Mock payment order
    await page.route('**/api/payments/order', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          provider: 'development',
          orderId: 'dev-order-999',
          amount: 60000,
          currency: 'INR',
        }),
      });
    });

    // Mock payment confirm
    await page.route('**/api/payments/confirm', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        // Shape of the real /api/payments/confirm response: the booking row with its status.
        body: JSON.stringify({
          id: 'booking-999',
          status: 'CONFIRMED',
          confirmed: true,
          bookingId: 'booking-999',
          reference: 'SAM-2026-999',
        }),
      });
    });

    const cartPage = new CartPage(page);
    await cartPage.seedCart([
      {
        productId: 'prod-premier-day1',
        name: 'Premier Section',
        category: 'Premier',
        kind: 'DAILY',
        showTitle: 'Opening Play',
        startsAt: '2026-12-19T18:00:00.000Z',
        unitPrice: 30000,
        version: 1,
        quantity: 2,
      },
    ]);

    await page.goto('/cart/checkout');
    await page.waitForLoadState('domcontentloaded');

    // Confirm line is listed
    await expect(page.locator('article.card')).toBeVisible();

    // Trigger checkout button
    const payBtn = page.locator('button.btn--primary', { hasText: /Pay|পেমেন্ট/i });
    await expect(payBtn).toBeVisible();
    await payBtn.click();

    // Verification of confirmation redirect
    await page.waitForURL('**/tickets**', { timeout: 15000 });
  });
});
