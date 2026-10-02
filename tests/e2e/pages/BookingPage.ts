import { Page, Locator } from '@playwright/test';

export class BookingPage {
  readonly page: Page;
  readonly nameInput: Locator;
  readonly contactInput: Locator;
  readonly qtySelect: Locator;
  readonly addToCartButton: Locator;
  readonly reserveButton: Locator;
  readonly errorMessage: Locator;
  readonly successBanner: Locator;

  constructor(page: Page) {
    this.page = page;
    this.nameInput = page.locator('#buyer-name');
    this.contactInput = page.locator('#buyer-contact');
    this.qtySelect = page.locator('#qty');
    this.addToCartButton = page.locator('button', { hasText: /Add to cart|কার্টে যোগ করুন/i });
    this.reserveButton = page.locator('a[href="/cart"], button', { hasText: /Reserve|Pay|চেকআউট|রিজার্ভ/i });
    this.errorMessage = page.locator('p[role="alert"]');
    this.successBanner = page.locator('.banner--ok');
  }

  async goto(productId: string) {
    await this.page.context().addCookies([
      { name: 'samatat-locale', value: 'en', domain: 'localhost', path: '/' },
    ]);
    await this.page.goto(`/book/${productId}`);
    await this.page.waitForLoadState('domcontentloaded');
  }

  async fillBuyerDetails(name: string, contact: string, quantity = 1) {
    await this.nameInput.waitFor({ state: 'visible' });
    await this.nameInput.fill(name);
    await this.contactInput.fill(contact);
    if (await this.qtySelect.isVisible()) {
      await this.qtySelect.selectOption(`${quantity}`);
    }
  }

  async addToCart() {
    await this.addToCartButton.click();
  }
}
