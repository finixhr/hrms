// ============ robots.txt (§62: public INDEXABLE, private NOINDEX) ============
import type { MetadataRoute } from "next"
import { SITE } from "@/saas/web/site"

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/api/",
          "/app",
          "/owner",
          "/iclock/",
          "/ISAPI/",
          "/registration-status",
        ],
      },
    ],
    sitemap: `${SITE.url.replace(/\/$/, "")}/sitemap.xml`,
  }
}
