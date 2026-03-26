#!/usr/bin/env node
/**
 * Migration script: codigo-obsidiana MDX files → Strapi CMS
 *
 * Usage:
 *   STRAPI_URL=http://localhost:1337 \
 *   STRAPI_API_TOKEN=<token> \
 *   CONTENT_PATH=/path/to/codigo-obsidiana/src/content \
 *   node scripts/migrate.mjs
 *
 * The script is idempotent: re-running it skips entries that already exist.
 */

import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STRAPI_URL = process.env.STRAPI_URL ?? 'http://localhost:1337';
const STRAPI_API_TOKEN = process.env.STRAPI_API_TOKEN ?? '';
const CONTENT_PATH = process.env.CONTENT_PATH ?? '';

const CDN_BASE = 'https://vpvt9bhoj9p6mo3d.public.blob.vercel-storage.com/';
const CDN_BLOG = 'blog/';
const CDN_PROJECT = 'project/';

if (!STRAPI_API_TOKEN) {
  console.error('❌  STRAPI_API_TOKEN is required');
  process.exit(1);
}

if (!CONTENT_PATH) {
  console.error('❌  CONTENT_PATH is required (path to /src/content of codigo-obsidiana)');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strips MDX-specific syntax from a body string, leaving clean Markdown.
 *
 * Removes:
 *  - import statements
 *  - <img> JSX tags that reference the CDN (replaced with actual markdown images)
 *  - Other JSX <img> tags (removed)
 */
function cleanMdxBody(body, imageName, cdnType) {
  let cleaned = body;

  // Remove import statements
  cleaned = cleaned.replace(/^import\s+.*?from\s+['"].*?['"];?\s*$/gm, '');

  // Replace CDN image JSX with actual markdown image
  // Matches: <img src={`${CDN.IMAGES}${TYPE.BLOG}${frontmatter.image}`} alt={frontmatter.title} />
  const imageUrl = `${CDN_BASE}${cdnType}${imageName}`;
  cleaned = cleaned.replace(
    /<img\s[^>]*src=\{`[^`]*`\}[^>]*\/>/gs,
    `![image](${imageUrl})`
  );

  // Remove any remaining self-closing JSX img tags
  cleaned = cleaned.replace(/<img\s[^>]*\/>/gs, '');

  // Convert JSX <a href="url" target="_blank">text</a> → [text](url)
  cleaned = cleaned.replace(
    /<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
    (_, href, content) => {
      // Strip any inner HTML tags from the link text
      const text = content.replace(/<[^>]+>/g, '').trim();
      return text ? `[${text}](${href})` : href;
    }
  );

  // Remove leftover empty lines (collapse 3+ newlines to 2)
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  return cleaned.trim();
}

async function strapiRequest(method, endpoint, body) {
  const url = `${STRAPI_URL}/api${endpoint}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${STRAPI_API_TOKEN}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Strapi ${method} ${endpoint} → ${res.status}: ${text.slice(0, 200)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Strapi ${method} ${endpoint} → non-JSON response: ${text.slice(0, 200)}`);
  }
}

/** Create a new entry in the default locale (en) */
async function createEntry(contentType, data) {
  const res = await strapiRequest('POST', `/${contentType}`, { data });
  return res.data.documentId;
}

/**
 * Add or update a localization for an existing document.
 * In Strapi 5 this is: PUT /:contentType/:documentId?locale=:locale
 */
async function addLocalization(contentType, documentId, locale, data) {
  await strapiRequest('PUT', `/${contentType}/${documentId}?locale=${locale}`, { data });
}

/** Returns the documentId of an entry regardless of publish status */
async function findEntryBySlug(contentType, slug, locale) {
  const qs = `?filters[slug][$eq]=${encodeURIComponent(slug)}&locale=${locale}&pagination[pageSize]=1`;
  const res = await strapiRequest('GET', `/${contentType}${qs}`);
  return res.data?.[0]?.documentId ?? null;
}

// ---------------------------------------------------------------------------
// Blog post migration
// ---------------------------------------------------------------------------

async function migrateBlogPosts() {
  const enDir = path.join(CONTENT_PATH, 'blog', 'en');
  const esDir = path.join(CONTENT_PATH, 'blog', 'es');

  const files = fs.readdirSync(enDir).filter((f) => f.endsWith('.mdx') || f.endsWith('.md'));

  console.log(`\n📝  Blog posts (${files.length} pairs)`);

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const filename of files) {
    const slug = filename.replace(/\.(mdx|md)$/, '');

    try {
      // Parse EN file
      const enRaw = fs.readFileSync(path.join(enDir, filename), 'utf-8');
      const { data: enFm, content: enBody } = matter(enRaw);

      // Parse ES file (must exist with same filename)
      const esFilePath = path.join(esDir, filename);
      if (!fs.existsSync(esFilePath)) {
        throw new Error(`Missing ES counterpart: ${esFilePath}`);
      }
      const esRaw = fs.readFileSync(esFilePath, 'utf-8');
      const { data: esFm, content: esBody } = matter(esRaw);

      const enDocId = await findEntryBySlug('blog-posts', slug, 'en');
      const esDocId = await findEntryBySlug('blog-posts', slug, 'es');

      if (enDocId && esDocId) {
        console.log(`  ⤷  skipped (both locales exist): ${slug}`);
        skipped++;
        continue;
      }

      const enData = {
        title: enFm.title,
        description: enFm.description,
        body: cleanMdxBody(enBody, enFm.image, CDN_BLOG),
        slug,
        publishDate: new Date(enFm.publishDate).toISOString(),
        updated: enFm.updated ? new Date(enFm.updated).toISOString() : null,
        tags: enFm.tags ?? [],
        author: enFm.author,
        readingTime: enFm.readingTime ?? null,
        image: enFm.image,
        draft: enFm.draft ?? false,
      };

      const documentId = enDocId ?? await createEntry('blog-posts', { ...enData, locale: 'en' });

      if (!esDocId) {
        const esData = {
          title: esFm.title,
          description: esFm.description,
          body: cleanMdxBody(esBody, esFm.image, CDN_BLOG),
          slug,
          publishDate: new Date(esFm.publishDate).toISOString(),
          updated: esFm.updated ? new Date(esFm.updated).toISOString() : null,
          tags: esFm.tags ?? [],
          author: esFm.author,
          readingTime: esFm.readingTime ?? null,
          image: esFm.image,
          draft: esFm.draft ?? false,
        };
        await addLocalization('blog-posts', documentId, 'es', esData);
      }

      console.log(`  ✓  created: ${slug}`);
      created++;
    } catch (err) {
      console.error(`  ✗  failed: ${slug} — ${err.message}`);
      failed++;
    }
  }

  console.log(`     → created: ${created}, skipped: ${skipped}, failed: ${failed}`);
}

// ---------------------------------------------------------------------------
// Project migration
// ---------------------------------------------------------------------------

async function migrateProjects() {
  const enDir = path.join(CONTENT_PATH, 'projects', 'en');
  const esDir = path.join(CONTENT_PATH, 'projects', 'es');

  const files = fs.readdirSync(enDir).filter((f) => f.endsWith('.mdx') || f.endsWith('.md'));

  console.log(`\n🗂️   Projects (${files.length} pairs)`);

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const filename of files) {
    const slug = filename.replace(/\.(mdx|md)$/, '');

    try {
      const enRaw = fs.readFileSync(path.join(enDir, filename), 'utf-8');
      const { data: enFm, content: enBody } = matter(enRaw);

      const esFilePath = path.join(esDir, filename);
      if (!fs.existsSync(esFilePath)) {
        throw new Error(`Missing ES counterpart: ${esFilePath}`);
      }
      const esRaw = fs.readFileSync(esFilePath, 'utf-8');
      const { data: esFm, content: esBody } = matter(esRaw);

      const enDocId = await findEntryBySlug('projects', slug, 'en');
      const esDocId = await findEntryBySlug('projects', slug, 'es');

      if (enDocId && esDocId) {
        console.log(`  ⤷  skipped (both locales exist): ${slug}`);
        skipped++;
        continue;
      }

      const enData = {
        title: enFm.title,
        description: enFm.description,
        body: cleanMdxBody(enBody, enFm.image, CDN_PROJECT),
        slug,
        publishDate: new Date(enFm.publishDate).toISOString(),
        technologies: enFm.technologies ?? [],
        tags: enFm.tags ?? [],
        role: enFm.role ?? '',
        company: enFm.company ?? '',
        status: enFm.status ?? '',
        image: enFm.image,
        imageProjectPrefix: enFm.imageProjectPrefix ?? '',
        showInAbout: enFm.showInAbout ?? true,
      };

      const documentId = enDocId ?? await createEntry('projects', { ...enData, locale: 'en' });

      if (!esDocId) {
        const esData = {
          title: esFm.title,
          description: esFm.description,
          body: cleanMdxBody(esBody, esFm.image, CDN_PROJECT),
          slug,
          publishDate: new Date(esFm.publishDate).toISOString(),
          technologies: esFm.technologies ?? [],
          tags: esFm.tags ?? [],
          role: esFm.role ?? '',
          company: esFm.company ?? '',
          status: esFm.status ?? '',
          image: esFm.image,
          imageProjectPrefix: esFm.imageProjectPrefix ?? '',
          showInAbout: esFm.showInAbout ?? true,
        };
        await addLocalization('projects', documentId, 'es', esData);
      }

      console.log(`  ✓  created: ${slug}`);
      created++;
    } catch (err) {
      console.error(`  ✗  failed: ${slug} — ${err.message}`);
      failed++;
    }
  }

  console.log(`     → created: ${created}, skipped: ${skipped}, failed: ${failed}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`🚀  Starting migration`);
console.log(`    Strapi:  ${STRAPI_URL}`);
console.log(`    Content: ${CONTENT_PATH}`);

await migrateBlogPosts();
await migrateProjects();

console.log('\n✅  Migration complete');
