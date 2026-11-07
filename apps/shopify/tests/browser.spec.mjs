import { expect, test } from '@playwright/test';

test('simulated checkout, owner-approved partial refund, expiry and mobile layout', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/app');
  await expect(page.getByText('LOCAL SIMULATOR · NO REAL FUNDS')).toBeVisible();
  await page.getByRole('button', { name: 'Open test checkout' }).click();
  await expect(page.getByRole('heading', { name: 'Complete the test payment' })).toBeVisible();
  const token = new URL(page.url()).pathname.split('/').at(-1);
  await page.getByRole('button', { name: 'Simulate payment', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Confirmed', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Return to store', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Order paid.', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'View payments and refunds' }).click();
  const paymentRow = page
    .locator('tr')
    .filter({ has: page.locator(`input[name="token"][value="${token}"]`) });
  await paymentRow.locator('input[name="amount"]').fill('0.25');
  await paymentRow.getByRole('button', { name: 'Request refund' }).click();
  const refundRow = page
    .getByRole('row')
    .filter({ hasText: 'Awaiting Tendr wallet approval' })
    .first();
  await expect(refundRow).toContainText('0.25 USD');
  await refundRow.getByRole('button', { name: 'Simulate wallet approval' }).click();
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: 'Refund' })
      .filter({ hasText: '0.25 USD' })
      .filter({ hasText: 'Confirmed' })
      .first(),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Open test checkout' }).click();
  await page.getByRole('button', { name: 'Simulate expiry', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Rejected', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Return to store', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Payment rejected.', exact: true })).toBeVisible();
  await page.goto('/app');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Open test checkout' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(errors).toEqual([]);
});
