# decisions-image-input

Turn a trusted image URL into an inline base64 data URL, build an OpenAI Decisions request, and evaluate named predicates. Includes a YouTube thumbnail adapter and experimental brand-safety prompts.

**Zero runtime dependencies. Node.js 22.9 or later. MIT licensed.** Works as a JavaScript library or a CLI.

## Why this exists

The [Decisions API](https://developers.openai.com/api/docs/guides/decisions) accepts images as inline base64 data URLs. It does not accept hosted HTTP/HTTPS image URLs or file IDs. An application must download and encode the image before submitting it.

Base64 encoding alone is easy. This project packages the surrounding work so applications can reuse it:

- Bounded image downloads with timeouts, exact hostname allowlists, and no redirect following.
- JPEG, PNG, and WebP detection from byte signatures rather than filename extensions.
- A pure request builder you can use without calling OpenAI.
- A YouTube Data API adapter that selects the largest available thumbnail.
- Named, repeatable predicates and versioned prompt sets.
- Redacted API failures and explicit refusal handling.

```text
Trusted image URL ── download ── base64 data URL ── Decisions API
YouTube video ID ── videos.list ── thumbnail URL ──────┘
```

Conversion, request building, and inference are separate operations. You can use only the part you need.

## Quick start

```sh
git clone https://github.com/rrhaya/decisions-image-input.git
cd decisions-image-input
node bin/decisions-image.js --help
npm test
```

There is no dependency installation or build step when running from a checkout.

### 1. Convert a thumbnail URL without API keys

```sh
# Replace VIDEO_ID with a real 11-character YouTube video ID.
node bin/decisions-image.js data-url \
  'https://i.ytimg.com/vi/VIDEO_ID/hqdefault.jpg'
```

The command writes `data:image/jpeg;base64,...` to stdout. It downloads the image but does not call YouTube Data API or OpenAI. The input must already be a valid image URL; a YouTube watch-page URL is not an image URL.

For a different image provider, explicitly allow its exact hostname:

```sh
node bin/decisions-image.js data-url \
  'https://images.example.com/photo.png' \
  --allow-host images.example.com
```

`images.example.com` is a placeholder. Substitute your trusted image host and URL.

### 2. Configure API keys for inference

For YouTube video-ID lookup:

1. Create or select a Google Cloud project.
2. Enable **YouTube Data API v3**.
3. Create an API key restricted to YouTube Data API v3, with application restrictions appropriate to your environment. See [YouTube API setup](https://developers.google.com/youtube/v3/getting-started).

For Decisions inference:

1. Create an API key for your project in [OpenAI Platform](https://platform.openai.com/api-keys).
2. Configure API billing/credits and check that your project can use the Decisions API with `gpt-6-luna`.

OpenAI API billing is separate from ChatGPT/Codex subscription usage. The Codex SDK does not provide a subscription-backed `/v1/decisions` client. See [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) and [pricing](https://learn.chatgpt.com/docs/pricing).

Set `YOUTUBE_API_KEY` and `OPENAI_API_KEY` in your shell, or create a local `.env` from the blank example:

```sh
# On a fresh checkout; do not overwrite an existing .env.
cp .env.example .env
# Edit .env locally and fill in the two keys.
```

```dotenv
YOUTUBE_API_KEY=your-youtube-api-key
OPENAI_API_KEY=your-openai-api-key
```

`npm run cli` loads `.env` if present. Existing shell variables take precedence. If using direnv, put `export YOUTUBE_API_KEY=...` and `export OPENAI_API_KEY=...` in `.envrc`, run `direnv allow`, and use the CLI normally. Both files are Git-ignored. Do not paste real keys into issues or commit them.

### 3. Evaluate a YouTube thumbnail

```sh
npm run cli -- youtube VIDEO_ID --preset alcohol
```

This makes one YouTube `videos.list` call, one image download, and one Decisions call. It selects the first available size in this order: `maxres`, `standard`, `high`, `medium`, `default`. The Data API returns the thumbnail URL; the adapter then downloads its bytes. The default inference input contains the image alone.

```sh
# Include video metadata explicitly.
npm run cli -- youtube VIDEO_ID --preset alcohol --with-metadata

# Ask your own yes/no questions in any supported language.
npm run cli -- youtube VIDEO_ID \
  --question 'Is a person drinking beer?' \
  --question 'Is a beer bottle visible?'

# Combine built-in and custom questions.
npm run cli -- youtube VIDEO_ID --preset food \
  --question 'Are cooking utensils visible?'

# Build a request for inspection or piping, without an OpenAI call.
# This output includes the full image data. Requires only YOUTUBE_API_KEY.
npm run --silent cli -- youtube VIDEO_ID --preset alcohol --request-only
```

### 4. Evaluate another trusted image URL

```sh
# Requires OPENAI_API_KEY, but not YOUTUBE_API_KEY.
npm run cli -- image 'https://images.example.com/photo.png' \
  --allow-host images.example.com \
  --question 'Is the product visibly damaged?'
```

Default trusted image hosts are `i.ytimg.com` and `img.youtube.com`. Generic URL commands can replace this list using repeatable `--allow-host` options. The YouTube adapter always uses the fixed YouTube host list.

## Reading the results

An illustrative answer looks like this:

```json
{
  "answers": [
    { "type": "predicate", "name": "alcohol", "probability": 0.98 }
  ],
  "hasRefusal": false
}
```

`0.98` is the model's estimated probability that the specific predicate is true for the supplied evidence. It is not image similarity, the fraction of pixels containing alcohol, or a guarantee of 98% classification accuracy. A zero result does not prove that an entire video is safe. Choose thresholds using reviewed examples and the cost of mistakes.

Refusals remain `{ "type": "refusal", "name": ... }` and set `hasRefusal: true`; they never become zero probabilities. Predicates do not generate free-text explanations.

Normal CLI results include the source URL without its query string, image format and byte count, selected prompt version, questions, answers, model, token usage, and Decisions-call latency. Latency excludes YouTube and image-download time. Image base64 and keys are omitted from normal results. `data-url` and `--request-only` intentionally emit image data.

## Presets and brand safety

```sh
node bin/decisions-image.js presets
node bin/decisions-image.js presets --framework garm

# All 11 categories × two predicates, in one Decisions request.
npm run cli -- youtube VIDEO_ID --framework garm

# Compare topic presence with an observable warning signal.
npm run cli -- youtube VIDEO_ID --framework garm \
  --preset drugs_tobacco_alcohol_topic \
  --preset drugs_tobacco_alcohol_floor_signal
```

With no question options, all presets in the selected framework are sent. `--question` alone sends only custom predicates. Repeated `--preset` and `--question` options combine them. `--preset all` selects every preset.

The basic framework has eight prompts: alcohol, real-world violence, game combat, sexual content, news context, education context, food, and sports.

The GARM framework is an **experimental, original prompt adaptation** of the 11 categories incorporated by IAB Content Taxonomy 2.2 from the September 2020 GARM framework. It deliberately separates:

- `*_topic`: whether the subject or expression is present.
- `*_floor_signal`: whether the particular harmful expression described in our prompt is observable.

An adult beer review can score high on topic presence and low on a signal about promoting underage drinking. Topic presence alone is not a brand-safety violation.

These 22 predicates do **not** reproduce every official Floor condition, assign formal Low/Medium/High/Floor risk levels, emit official IAB category IDs, or automatically approve advertising. They cover selected observable signals for a first-pass experiment. Piracy, malware behavior, legality, age, and truthfulness often require evidence beyond a thumbnail. Absence of a visible signal is not proof of absence in a video. News and education context should inform review rather than automatically override harmful imagery.

The exact prompt version is `garm-2020-iab-2.2-thumbnail-draft-v1`. [IAB's current taxonomy page](https://iabtechlab.com/standards/content-taxonomy/) lists 3.1; this project does not claim current IAB conformance. [WFA notes](https://wfanet.org/knowledge/item/2022/06/17/GARM-Brand-Safety-Floor--Suitability-Framework-3) that GARM discontinued its activities on August 8, 2024. This fixed historical reference is intentional and is not a claim to cover later framework revisions.

References: [IAB's 2020 implementation guide](https://iabtechlab.com/wp-content/uploads/2020/12/Implementation_Guide_for_Brand_Suitability_with_IABTechLab_Content_Taxonomy_2-2.pdf), [WFA's public 2020 framework](https://wb01.wfanet.org/l/library/download/urn-uuid-7d484745-41cd-4cce-a1b9-a1b4e30928ea/garm-brand-safety-floor-suitability-framework-23-sept-format-save_to_disk-ext-.pdf). The repository contains our own prompts, not copies of those documents. No endorsement by OpenAI, YouTube, IAB, or WFA is implied.

## JavaScript / TypeScript library

Install from GitHub, or import `./src/index.js` from a checkout. This initial release is distributed through GitHub, not the npm registry.

```sh
npm install github:rrhaya/decisions-image-input
```

```js
import {
  imageUrlToDataUrl,
  presetQuestions,
  buildDecisionRequest,
  createDecision,
} from 'decisions-image-input';

const image = await imageUrlToDataUrl(
  'https://images.example.com/photo.png',
  { allowedHosts: ['images.example.com'], maxBytes: 5 * 1024 * 1024 }
);

const request = buildDecisionRequest({
  dataUrl: image.dataUrl,
  questions: presetQuestions({ custom: ['Is the product visibly damaged?'] }),
});

const result = await createDecision(request, {
  apiKey: process.env.OPENAI_API_KEY,
});
console.log(result.answers);
```

You can pass the built request to an official OpenAI client instead. The library does not require a specific SDK version.

Exports include `imageBytesToDataUrl`, `imageUrlToDataUrl`, `youtubeThumbnail`, `listPresets`, `presetQuestions`, `buildDecisionRequest`, `createDecision`, and `InputError`. Type declarations are included. This release's request builder and inference helper support **predicate questions only**.

Network helpers accept an optional `fetcher` and `timeoutMs`, making the complete pipeline testable without live API calls. Download helpers also accept `maxBytes`; the default local cap is 10 MiB, not a statement of the API's size limit.

## Boundaries and troubleshooting

- URLs must use HTTPS with no credentials, fragments, nonstandard ports, IP literals, or local hostnames. Redirects are rejected. Only exact allowed hosts can be fetched.
- An allowlist is a trust boundary, not a full SSRF sandbox: it does not pin DNS results or police a server's egress. Do not let untrusted users choose the allowlist in a server application. Use network-level controls there.
- Format detection checks magic bytes; it is not a full image decoder or malware scan. JPEG, PNG, and WebP are supported; GIF and other formats are not handled in this release.
- YouTube and OpenAI keys are sent only to their respective fixed API endpoints. Image requests carry neither key. YouTube keys use the `X-Goog-Api-Key` header rather than a query parameter.
- Images remain in memory. The tool does not save images, metadata, or responses unless you redirect stdout. Follow applicable provider rules when storing API data.
- API and network failures exit with code 1. No automatic paid retries are performed.
- API response bodies and free-text errors are redacted. Known OpenAI error codes/types and numeric `Retry-After` values are shown when available.
- A 429 can mean exhausted credits, an organization/project limit, or a temporary rate limit. Check the printed code; billing-related errors require action, not repeated retries. See [OpenAI error codes](https://developers.openai.com/api/docs/guides/error-codes).
- If `.env` is missing, Node may print a notice and continue. That is expected when keys are supplied through the shell or direnv.

## Development and validation

```sh
npm run check
npm test
npm pack --dry-run
```

Tests use synthetic images, dummy keys, and mocked fetch calls. They exercise encoding, bounded downloads, URL validation, key isolation, request-only mode, metadata opt-in, refusal handling, response validation, and redacted diagnostics. They make no paid API calls. CI runs the same checks on Node.js 22 and 24.

Live account access, API billing, image classification quality, and brand-safety accuracy are not established by these tests. Run your own small live sample after configuring keys; review boundary cases before building an advertising policy around the output.

Contributions should include a focused test, document any changed network destination, and version any prompt changes that affect results. Use synthetic data and never submit credentials.

## License

MIT. See [LICENSE](LICENSE).
