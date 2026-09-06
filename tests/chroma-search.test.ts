import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogueDocuments, searchCatalogue } from '../src/lib/chroma';

const show = { id: 'show-1', title: 'Raktakarabi', title_bn: 'রক্তকরবী', troupe: 'Festival Ensemble', synopsis: 'A searching drama', synopsis_bn: 'নাটক', starts_at: '', ends_at: '', language: 'Bengali', runtime: 90, genre: 'Drama', artwork: 'red', status: 'PUBLISHED' };
const product = { id: 'product-1', name: 'Premier Daily', name_bn: 'প্রিমিয়ার দৈনিক', category: 'Premier', kind: 'DAILY' as const, price: 500, version: 1, enabled: true, show_id: 'show-1', available: 12, coverage: [show] };

test('catalogue documents contain searchable bilingual show and product content', () => {
  const documents = catalogueDocuments([show], [product]);
  assert.equal(documents.length, 2);
  assert.match(documents[0].document, /Raktakarabi/);
  assert.match(documents[1].document, /প্রিমিয়ার/);
  assert.equal(documents[1].metadata.kind, 'product');
  assert.equal(documents[1].metadata.available, 12);
});

test('document ids are stable across re-indexing', () => {
  const first = catalogueDocuments([show], [product]).map(document => document.id);
  const second = catalogueDocuments([show], [product]).map(document => document.id);
  assert.deepEqual(first, second);
});

test('search maps Chroma results into the public result shape', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    if (requests.length === 1) return Response.json({ id: 'collection-1' });
    return Response.json({ ids: [['product:product-1']], documents: [['Premier Daily Premier']], metadatas: [[{ kind: 'product', productId: 'product-1', title: 'Premier Daily', titleBn: 'প্রিমিয়ার দৈনিক', price: 500, available: 12 }]], distances: [[0.2]] });
  };
  process.env.CHROMA_URL = 'http://chroma.test';
  try {
    const results = await searchCatalogue('premier', 3);
    assert.equal(results[0].productId, 'product-1');
    assert.equal(results[0].score, 0.8);
    assert.match(requests[1], /collection-1\/query$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('blank searches do not contact Chroma', async () => {
  assert.deepEqual(await searchCatalogue('  '), []);
});
