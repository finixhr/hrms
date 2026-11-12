-- Website CMS (platform plane): pages, features, clients, testimonials, media.
CREATE TABLE "SaaSCmsPage" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "pageType" TEXT NOT NULL DEFAULT 'CUSTOM',
    "status" TEXT NOT NULL DEFAULT 'PUBLISHED',
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "showInNav" BOOLEAN NOT NULL DEFAULT false,
    "navLabel" TEXT,
    "seoTitle" TEXT,
    "seoDesc" TEXT,
    "blocks" TEXT NOT NULL DEFAULT '[]',
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaaSCmsPage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SaaSCmsPage_slug_key" ON "SaaSCmsPage"("slug");
CREATE INDEX "SaaSCmsPage_pageType_status_sortOrder_idx" ON "SaaSCmsPage"("pageType", "status", "sortOrder");

CREATE TABLE "SaaSCmsFeature" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "navLabel" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "sub" TEXT NOT NULL,
    "visual" TEXT,
    "icon" TEXT NOT NULL DEFAULT 'star',
    "accent" TEXT NOT NULL DEFAULT 'blue',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "showOnHome" BOOLEAN NOT NULL DEFAULT true,
    "content" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaaSCmsFeature_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SaaSCmsFeature_slug_key" ON "SaaSCmsFeature"("slug");
CREATE INDEX "SaaSCmsFeature_visible_sortOrder_idx" ON "SaaSCmsFeature"("visible", "sortOrder");

CREATE TABLE "SaaSCmsClient" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "story" TEXT,
    "quote" TEXT,
    "personName" TEXT,
    "personRole" TEXT,
    "metrics" TEXT NOT NULL DEFAULT '[]',
    "logoText" TEXT,
    "logoColor" TEXT NOT NULL DEFAULT '#2563eb',
    "logoUrl" TEXT,
    "website" TEXT,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaaSCmsClient_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SaaSCmsClient_visible_sortOrder_idx" ON "SaaSCmsClient"("visible", "sortOrder");

CREATE TABLE "SaaSCmsTestimonial" (
    "id" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "personName" TEXT NOT NULL,
    "personRole" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "rating" INTEGER NOT NULL DEFAULT 5,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaaSCmsTestimonial_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SaaSCmsTestimonial_visible_sortOrder_idx" ON "SaaSCmsTestimonial"("visible", "sortOrder");

CREATE TABLE "SaaSCmsMedia" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaaSCmsMedia_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SaaSSiteSetting" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaaSSiteSetting_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SaaSSiteSetting_key_key" ON "SaaSSiteSetting"("key");
