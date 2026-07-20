import { defineCollection, z } from "astro:content";
import { glob, file } from "astro/loaders";

const links = defineCollection({
  loader: file("src/content/links.yaml"),
  schema: z.object({
    id: z.string(),
    title: z.string(),
    subtitle: z.string().optional(),
    url: z.string().optional(),
    thumbnail: z.string().optional(),
    bgImage: z.string().optional(),
    cta: z.string().optional(),
    copy: z.string().optional(),
    align: z.enum(["center", "topLeft"]).default("center"),
    featured: z.boolean().default(false),
  }),
});

const faqs = defineCollection({
  loader: file("src/content/faqs.yaml"),
  schema: z.object({
    id: z.string(),
    question: z.string(),
    answer: z.string(),
  }),
});

const impact = defineCollection({
  loader: file("src/content/impact.yaml"),
  schema: z.object({
    id: z.string(),
    value: z.string(),
    label: z.string(),
    sublabel: z.string().optional(),
  }),
});

const beliefs = defineCollection({
  loader: file("src/content/beliefs.yaml"),
  schema: z.object({
    id: z.string(),
    body: z.string(),
  }),
});

export const collections = { links, faqs, impact, beliefs };
