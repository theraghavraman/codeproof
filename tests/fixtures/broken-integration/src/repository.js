export async function findOrders(db, customerId) {
  return db.query('SELECT id, customer_id, total_cents, shipped_at FROM orders WHERE customer_id = $1', [customerId]);
}

export async function findByStatus(db, status) {
  return db.query(`SELECT id FROM orders WHERE status = '${status}'`);
}
