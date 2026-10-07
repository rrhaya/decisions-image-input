import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { imageBytesToDataUrl, imageUrlToDataUrl, youtubeThumbnail, presetQuestions, listPresets, buildDecisionRequest, createDecision } from '../src/index.js';
import { parseArgs, run } from '../bin/decisions-image.js';

const id = 'abcdefghijk';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=', 'base64');
const imageUrl = `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
const env = { YOUTUBE_API_KEY: 'dummy-youtube', OPENAI_API_KEY: 'dummy-openai' };
const video = { items: [{ id, snippet: { title: 'Synthetic beer review', description: 'Synthetic metadata', tags: ['synthetic'], thumbnails: { high: { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` }, maxres: { url: imageUrl } } } }] };
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function mock(respond) {
  const calls = [];
  return { calls, fetcher: async (url, options) => {
    calls.push({ url: String(url), options });
    if (respond) {
      const result = respond(String(url), options, calls.length);
      if (result !== undefined) return result;
    }
    if (String(url).startsWith('https://www.googleapis.com/')) return json(video);
    if (String(url).startsWith('https://i.ytimg.com/')) return new Response(png);
    if (String(url) === 'https://api.openai.com/v1/decisions') {
      const body = JSON.parse(options.body);
      return json({ model: 'gpt-6-luna', usage: { input_tokens: 100 }, answers: body.questions.map(q => ({ name: q.name, type: 'predicate', probability: 0.25 })) });
    }
    throw new Error('Unexpected mock destination');
  } };
}

test('byte encoding preserves synthetic PNG and detects supported signatures', () => {
  assert.equal(imageBytesToDataUrl(png).dataUrl, `data:image/png;base64,${png.toString('base64')}`);
  assert.equal(imageBytesToDataUrl(Buffer.from([255, 216, 255, 0])).mime, 'image/jpeg');
  assert.equal(imageBytesToDataUrl(Buffer.from('RIFF0000WEBP')).mime, 'image/webp');
  for (const value of [Buffer.from('<html>error</html>'), Buffer.alloc(0), 'not bytes']) assert.throws(() => imageBytesToDataUrl(value));
});

test('URL conversion requires an exact allowlist and rejects insecure or local inputs before fetch', async () => {
  const transport = mock();
  for (const url of ['http://i.ytimg.com/a.png', 'https://example.com/a.png', 'https://i.ytimg.com.evil.test/a.png', 'https://user:secret@i.ytimg.com/a.png', 'https://i.ytimg.com:8443/a.png', 'https://127.0.0.1/a.png', 'https://[::1]/a.png', 'https://localhost/a.png', 'https://test.local/a.png']) {
    await assert.rejects(imageUrlToDataUrl(url, { fetcher: transport.fetcher }));
  }
  assert.equal(transport.calls.length, 0);
});

test('explicit generic image host works and signed query is omitted from source metadata', async () => {
  const calls = [];
  const result = await imageUrlToDataUrl('https://images.example.com/a.png?signature=dummy-secret', { allowedHosts: ['images.example.com'], fetcher: async (url, options) => { calls.push({ url, options }); return new Response(png); } });
  assert.equal(result.sourceUrl, 'https://images.example.com/a.png');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers, undefined);
  assert(calls[0].options.signal instanceof AbortSignal);
});

test('download size limits apply to headers and streamed bytes', async () => {
  for (const response of [new Response(png, { headers: { 'Content-Length': '1000' } }), new Response(Buffer.alloc(1000))]) {
    await assert.rejects(imageUrlToDataUrl(imageUrl, { maxBytes: 100, fetcher: async () => response }), /byte limit/);
  }
  await assert.rejects(imageUrlToDataUrl(imageUrl, { maxBytes: 0 }), /positive integer/);
});

test('redirects, fetch failures, and interrupted bodies are redacted', async () => {
  await assert.rejects(imageUrlToDataUrl(imageUrl, { fetcher: async () => { throw new Error('dummy-secret URL'); } }), error => !error.message.includes('dummy-secret') && /network failure/.test(error.message));
  const response = new Response(new ReadableStream({ start(controller) { controller.error(new Error('dummy-secret')); } }));
  await assert.rejects(imageUrlToDataUrl(imageUrl, { fetcher: async () => response }), /body download failed/);
});

test('YouTube adapter selects maximum resolution and keeps key out of URL and image request', async () => {
  const transport = mock();
  const image = await youtubeThumbnail(id, { apiKey: env.YOUTUBE_API_KEY, fetcher: transport.fetcher });
  assert.equal(image.size, 'maxres');
  assert.equal(image.dataUrl, imageBytesToDataUrl(png).dataUrl);
  assert.equal(image.metadata.title, 'Synthetic beer review');
  assert.equal(new URL(transport.calls[0].url).searchParams.get('id'), id);
  assert.equal(new URL(transport.calls[0].url).searchParams.get('part'), 'snippet');
  assert.equal(transport.calls[0].options.headers['X-Goog-Api-Key'], env.YOUTUBE_API_KEY);
  assert(!transport.calls[0].url.includes('dummy-'));
  assert.equal(transport.calls[1].options.headers, undefined);
});

test('YouTube adapter falls back to available size and stops on missing source', async () => {
  const fallback = structuredClone(video);
  delete fallback.items[0].snippet.thumbnails.maxres;
  const transport = mock((url, options, n) => n === 1 ? json(fallback) : undefined);
  assert.equal((await youtubeThumbnail(id, { apiKey: 'dummy', fetcher: transport.fetcher })).size, 'high');
  for (const source of [{ items: [] }, { items: [{ id, snippet: { thumbnails: {} } }] }]) {
    const missing = mock((url, options, n) => n === 1 ? json(source) : undefined);
    await assert.rejects(youtubeThumbnail(id, { apiKey: 'dummy', fetcher: missing.fetcher }), /not found|no thumbnail/);
    assert.equal(missing.calls.length, 1);
  }
});

test('keys and video ID are validated before any network call', async () => {
  const transport = mock();
  await assert.rejects(youtubeThumbnail('invalid', { apiKey: 'dummy', fetcher: transport.fetcher }), /video ID/);
  await assert.rejects(youtubeThumbnail(id, { fetcher: transport.fetcher }), /YOUTUBE_API_KEY/);
  await assert.rejects(run(parseArgs(['youtube', id]), { env: {}, fetcher: transport.fetcher }), /OPENAI_API_KEY/);
  assert.equal(transport.calls.length, 0);
});

test('request builder uses inline input_image and rejects URLs, duplicate names and invalid questions', () => {
  const request = buildDecisionRequest({ dataUrl: imageBytesToDataUrl(png).dataUrl, questions: presetQuestions({ selected: ['alcohol'] }) });
  assert.equal(request.input[0].content[1].type, 'input_image');
  assert.equal(request.model, 'gpt-6-luna');
  for (const input of [
    { dataUrl: imageUrl, questions: request.questions },
    { dataUrl: imageBytesToDataUrl(png).dataUrl, questions: [] },
    { dataUrl: imageBytesToDataUrl(png).dataUrl, questions: [...request.questions, ...request.questions] },
    { dataUrl: imageBytesToDataUrl(png).dataUrl, questions: [{ type: 'choice', name: 'x', instructions: 'x' }] }
  ]) assert.throws(() => buildDecisionRequest(input));
});

test('custom predicates can replace or supplement presets', () => {
  assert.equal(presetQuestions().length, 8);
  assert.equal(presetQuestions({ custom: ['Is a bottle visible?'] }).length, 1);
  assert.deepEqual(presetQuestions({ selected: ['alcohol', 'alcohol'], custom: ['Is a bottle visible?'] }).map(q => q.name), ['alcohol', 'custom_1']);
  assert.throws(() => presetQuestions({ selected: ['unknown'] }), /Unknown preset/);
});

test('GARM draft supplies 11 distinct topic/signal pairs and a fixed version', () => {
  const { questions, version } = listPresets('garm');
  assert.equal(version, 'garm-2020-iab-2.2-thumbnail-draft-v1');
  assert.equal(Object.keys(questions).length, 22);
  assert.equal(Object.keys(questions).filter(name => name.endsWith('_topic')).length, 11);
  assert.equal(Object.keys(questions).filter(name => name.endsWith('_floor_signal')).length, 11);
  assert.match(questions.drugs_tobacco_alcohol_floor_signal, /Adult alcohol presentation alone does not qualify/);
  assert.throws(() => listPresets('unknown'));
});

test('end-to-end CLI runner performs three calls and omits image data and keys from results', async () => {
  const transport = mock();
  const result = await run(parseArgs(['youtube', id, '--preset', 'alcohol']), { env, fetcher: transport.fetcher });
  assert.equal(transport.calls.length, 3);
  const decisionCall = transport.calls[2];
  assert.equal(decisionCall.options.method, 'POST');
  assert.equal(decisionCall.options.headers.Authorization, `Bearer ${env.OPENAI_API_KEY}`);
  const body = JSON.parse(decisionCall.options.body);
  assert.equal(body.input[0].content[1].image_url, imageBytesToDataUrl(png).dataUrl);
  assert(!body.input[0].content[0].text.includes('Synthetic beer review'));
  assert.equal(result.answers[0].probability, 0.25);
  assert.equal(result.inputMode, 'image_only');
  assert(!JSON.stringify(result).includes(png.toString('base64')));
  assert(!JSON.stringify(result).includes('dummy-'));
});

test('metadata opt-in, generic image mode, and request-only behavior', async () => {
  const transport = mock();
  const body = await run(parseArgs(['youtube', id, '--with-metadata', '--request-only', '--question', 'Is beer visible?']), { env: { YOUTUBE_API_KEY: 'dummy' }, fetcher: transport.fetcher });
  assert.equal(transport.calls.length, 2);
  assert.match(body.input[0].content[0].text, /Synthetic beer review/);
  const generic = mock();
  const result = await run(parseArgs(['image', imageUrl, '--preset', 'food']), { env: { OPENAI_API_KEY: 'dummy' }, fetcher: generic.fetcher });
  assert.equal(generic.calls.length, 2);
  assert.equal(result.videoId, undefined);
});

test('conversion-only command needs no API key and makes one image call', async () => {
  const transport = mock();
  const output = await run(parseArgs(['data-url', imageUrl]), { env: {}, fetcher: transport.fetcher });
  assert.equal(output, imageBytesToDataUrl(png).dataUrl);
  assert.equal(transport.calls.length, 1);
});

test('refusals do not become zero probabilities', async () => {
  const transport = mock(url => url === 'https://api.openai.com/v1/decisions' ? json({ answers: [{ type: 'refusal', name: null, reason: 'untrusted extra text' }] }) : undefined);
  const result = await run(parseArgs(['image', imageUrl, '--preset', 'alcohol']), { env, fetcher: transport.fetcher });
  assert.equal(result.hasRefusal, true);
  assert.deepEqual(result.answers, [{ type: 'refusal', name: null }]);
});

test('429 displays only allowlisted diagnostics and never response messages', async () => {
  for (const code of ['credit_balance_exhausted', 'dummy-secret']) {
    const transport = mock(url => url === 'https://api.openai.com/v1/decisions' ? new Response(JSON.stringify({ error: { code, type: 'insufficient_quota', message: 'dummy-secret' } }), { status: 429, headers: { 'Retry-After': '30' } }) : undefined);
    await assert.rejects(run(parseArgs(['image', imageUrl, '--preset', 'alcohol']), { env, fetcher: transport.fetcher }), error => {
      assert.match(error.message, /HTTP 429/);
      assert.match(error.message, /type=insufficient_quota/);
      assert.match(error.message, /retry_after_seconds=30/);
      assert(!error.message.includes('dummy-secret'));
      if (code === 'credit_balance_exhausted') assert.match(error.message, /code=credit_balance_exhausted/);
      return true;
    });
  }
});

test('malformed, missing, or mismatched API answers fail explicitly', async () => {
  const request = buildDecisionRequest({ dataUrl: imageBytesToDataUrl(png).dataUrl, questions: presetQuestions({ selected: ['food'] }) });
  for (const answers of [[], [null], [{ name: 'food', type: 'predicate', probability: 2 }], [{ name: 'wrong', type: 'predicate', probability: 0.2 }]]) {
    await assert.rejects(createDecision(request, { apiKey: 'dummy', fetcher: async () => json({ answers }) }), /Decisions API:/);
  }
  await assert.rejects(createDecision(request, { apiKey: 'dummy', fetcher: async () => new Response('not JSON') }), /invalid JSON/);
});

test('CLI rejects ambiguous options and does not require keys for help or presets', async () => {
  for (const args of [['unknown'], ['image'], ['image', imageUrl, '--with-metadata'], ['youtube', id, '--allow-host', 'example.com'], ['data-url', imageUrl, '--question', 'x'], ['presets', '--request-only'], ['youtube', id, '--presetalcohol']]) assert.throws(() => parseArgs(args));
  const result = await run(parseArgs(['presets', '--framework', 'garm']), { env: {}, fetcher: async () => assert.fail('No calls allowed') });
  assert.equal(Object.keys(result.questions).length, 22);
  const processResult = spawnSync(process.execPath, ['bin/decisions-image.js', '--help'], { cwd: new URL('../', import.meta.url), encoding: 'utf8' });
  assert.equal(processResult.status, 0);
  assert.match(processResult.stdout, /decisions-image/);
});
