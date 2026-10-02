import { Page, Locator } from '@playwright/test';

export class CartPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly cartItems: Locator;
  readonly totalDisplay: Locator;
  readonly checkoutLink: Locator;
  readonly emptyNotice: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.locator('h1');
    this.cartItems = page.locator('article.card');
    this.totalDisplay = page.locator('div.card', { hasText: /Total|মোট/i });
    this.checkoutLink = page.locator('a[href="/cart/checkout"]');
    this.emptyNotice = page.locator('.card', { hasText: /Your cart is empty|আপনার কার্ট খালি/i });
  }

  async goto() {
    await this.page.context().addCookies([
      { name: 'samatat-locale', value: 'en', domain: 'localhost', path: '/' },
    ]);
    await this.page.goto('/cart');
    await this.page.waitForLoadState('domcontentloaded');
  }

  async seedCart(items: Array<{
    productId: string;
    name: string;
    category: string;
    kind: string;
    showTitle: string;
    startsAt: string;
    unitPrice: number;
    version: number;
    quantity: number;
  }>) {
    await this.page.addInitScript((cartItems) => {
      window.localStorage.setItem('samatat-cart', JSON.stringify(cartItems));
      window.localStorage.setItem('samatat-locale', 'en');
      document.cookie = 'samatat-locale=en;path=/;max-age=31536000';
    }, items);
  }

  async getCartItemsCount() {
    return await this.cartItems.count();
  }

  async clickIncrease(index = 0) {
    await this.cartItems.nth(index).locator('button', { hasText: '+' }).click();
  }

  async clickDecrease(index = 0) {
    await this.cartItems.nth(index).locator('button', { hasText: '–' }).click();
  }

  async removeItem(index = 0) {
    await this.cartItems.nth(index).locator('button.btn--ghost').click();
  }

  async proceedToCheckout() {
    await this.checkoutLink.click();
    await this.page.waitForURL('**/cart/checkout**');
  }
}
