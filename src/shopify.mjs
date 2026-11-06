// Admin API through the GraphiQL proxy that `shopify app dev` runs locally (the URL it prints).
export function graphqlEndpoint(graphiqlUrl, apiVersion) {
  const src = new URL(graphiqlUrl);
  const key = src.searchParams.get('key');
  if (!key) throw new Error('the GraphiQL URL has no ?key=');
  return `${src.origin}/graphiql/graphql.json?key=${encodeURIComponent(key)}&api_version=${encodeURIComponent(apiVersion)}`;
}

export async function adminGraphql(graphiqlUrl, apiVersion, query, variables = {}) {
  const res = await fetch(graphqlEndpoint(graphiqlUrl, apiVersion), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors) throw new Error(`Admin API ${res.status}: ${JSON.stringify(body.errors ?? body).slice(0, 300)}`);
  return body.data;
}

// Sets a shop metafield. Returns the shop's myshopify domain.
export async function setShopMetafield(graphiqlUrl, apiVersion, { namespace, key, value, type = 'single_line_text_field' }) {
  const { shop } = await adminGraphql(graphiqlUrl, apiVersion, '{ shop { id myshopifyDomain } }');
  const { metafieldsSet } = await adminGraphql(
    graphiqlUrl, apiVersion,
    'mutation ($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { message } } }',
    { m: [{ ownerId: shop.id, namespace, key, type, value }] },
  );
  if (metafieldsSet.userErrors.length) throw new Error(metafieldsSet.userErrors.map((e) => e.message).join('; '));
  return shop.myshopifyDomain;
}
