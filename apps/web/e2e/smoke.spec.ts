import { expect, test } from '@playwright/test';

test('landing page renders', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /One checkout/i })).toBeVisible();
  await expect(page.getByRole('link', { name: /Explore the demo/i })).toBeVisible();
});

test('ecommerce demo loads shared checkout', async ({ page }) => {
  await page.goto('/demo/ecommerce');
  await expect(page.getByText(/Sandbox — no real funds move/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /Start sandbox checkout/i })).toBeVisible();
});
