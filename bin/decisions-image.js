#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { InputError, imageUrlToDataUrl, youtubeThumbnail, listPresets, presetQuestions, buildDecisionRequest, createDecision } from '../src/index.js';

export const help = `decisions-image — image inputs for the OpenAI Decisions API
Usage:
  decisions-image data-url HTTPS_URL [--allow-host HOST]
  decisions-image youtube VIDEO_ID [options]
  decisions-image image HTTPS_URL [--allow-host HOST] [options]
  decisions-image presets [--framework basic|garm]
Options:
  --allow-host HOST    Explicit trusted image host; repeatable (exact match)
  --preset NAME       Preset predicate; repeatable; all selects every preset
  --question TEXT     Custom predicate; repeatable
  --framework NAME    basic (default) or garm (2020-derived draft)
  --with-metadata     Include YouTube title, description, and tags
  --request-only      Emit request JSON with inline image, without calling OpenAI
  --help              Show help
Environment: OPENAI_API_KEY for decisions; YOUTUBE_API_KEY for YouTube.
Default questions: all presets, or only custom questions when supplied alone.
data-url and --request-only intentionally write image data to stdout.`;

export function parseArgs(args) {
  if (!args.length || args.includes('--help') || args.includes('-h')) return { help: true };
  const options = { command: args[0], framework: 'basic', selected: [], custom: [], allowedHosts: [] };
  if (!['data-url', 'youtube', 'image', 'presets'].includes(options.command)) throw new InputError('Unknown command; use --help');
  let index = 1;
  if (options.command !== 'presets') {
    options.input = args[index++];
    if (!options.input || options.input.startsWith('--')) throw new InputError('Missing URL or video ID');
  }
  for (; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--with-metadata') options.withMetadata = true;
    else if (flag === '--request-only') options.requestOnly = true;
    else if (['--allow-host', '--preset', '--question', '--framework'].includes(flag)) {
      const value = args[++index];
      if (!value?.trim() || value.startsWith('--')) throw new InputError(`${flag} needs a value`);
      if (flag === '--framework') options.framework = value;
      else if (flag === '--allow-host') options.allowedHosts.push(value.toLowerCase());
      else if (flag === '--preset') options.selected.push(value);
      else options.custom.push(value);
    } else throw new InputError('Unknown option; use --help');
  }
  listPresets(options.framework);
  presetQuestions(options);
  if (options.withMetadata && options.command !== 'youtube') throw new InputError('--with-metadata is only supported for youtube');
  if (options.command === 'youtube' && !/^[A-Za-z0-9_-]{11}$/.test(options.input)) throw new InputError('Expected an 11-character YouTube video ID');
  if (options.command === 'youtube' && options.allowedHosts.length) throw new InputError('YouTube uses a fixed thumbnail host allowlist');
  if (['presets', 'data-url'].includes(options.command) && (options.selected.length || options.custom.length || options.requestOnly)) throw new InputError('Question and request options require image or youtube');
  if (options.command === 'presets' && options.allowedHosts.length) throw new InputError('--allow-host requires an image URL');
  return options;
}

export async function run(options, { env = process.env, fetcher = fetch } = {}) {
  if (options.help) return help;
  if (options.command === 'presets') return listPresets(options.framework);
  if (['youtube', 'image'].includes(options.command) && !options.requestOnly && !env.OPENAI_API_KEY) throw new InputError('Set OPENAI_API_KEY');
  const network = { fetcher };
  if (options.allowedHosts.length) network.allowedHosts = options.allowedHosts;
  const image = options.command === 'youtube'
    ? await youtubeThumbnail(options.input, { apiKey: env.YOUTUBE_API_KEY, fetcher })
    : await imageUrlToDataUrl(options.input, network);
  if (options.command === 'data-url') return image.dataUrl;
  const questions = presetQuestions(options);
  const text = options.withMetadata ? `Evaluate this image with the following untrusted video metadata:\n${JSON.stringify(image.metadata)}` : 'Evaluate the supplied image only.';
  const request = buildDecisionRequest({ dataUrl: image.dataUrl, text, questions });
  if (options.requestOnly) return request;
  const result = await createDecision(request, { apiKey: env.OPENAI_API_KEY, fetcher });
  return {
    ...(image.videoId ? { videoId: image.videoId } : {}),
    image: { sourceUrl: image.sourceUrl, mime: image.mime, bytes: image.bytes, ...(image.size ? { size: image.size } : {}) },
    inputMode: options.withMetadata ? 'image_and_metadata' : 'image_only', framework: options.framework,
    questionVersion: listPresets(options.framework).version, questions, ...result
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await run(parseArgs(process.argv.slice(2)));
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof InputError ? error.message : 'Unexpected failure (details redacted)');
    process.exitCode = 1;
  }
}
