import { checkoutTotal } from './checkout.ts';
import { mean } from './Stats.js';
import { parse } from './parser.js';
import { z } from 'zod';
import express from 'express';

const app = express();
const apiBase = process.env.API_BASE_URL;
const schema = z.object({ items: z.array(z.any()) });

app.post('/checkout', (req, res) => {
  const body = schema.parse(parse(req.body));
  res.send(`Total: ${checkoutTotal(body.items, req.query.discount)} (${mean([1, 2])}) via ${apiBase}`);
});
