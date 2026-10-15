export interface Money {
  amount: number;
  currency: string;
}

export function formatMoney(money: Money): string {
  return `${money.amount.toFixed(2)} ${money.currency}`;
}

export function sumMoney(items: Money[]): Money {
  const currency = items[0]?.currency ?? 'USD';
  return { amount: items.reduce((total, item) => total + item.amount, 0), currency };
}
