// ============ Block renderer — maps CMS page JSON to section components ============
// Server component: data-driven blocks await their collections, simple
// blocks render inline. Unknown block types render nothing (forward
// compatibility: a saved-but-unreleased block type never 500s the site).
import type { CmsBlock, SiteIdentity } from "@/saas/web/content-types"
import { HeroBlock } from "./hero-block"
import {
  CardsBlock, CtaBlock, CustomHtmlBlock, HowItWorksBlock, LogosBlock,
  StatsBlock, TextBlock, TextImageBlock, ValuePropsBlock,
} from "./simple-blocks"
import { ClientsBlock, FaqBlock, FeatureDemoBlock, FeaturesBlock, TestimonialsBlock } from "./data-blocks"
import { ContactBlock, PricingBlock } from "./pricing-contact-blocks"

export async function BlockRenderer({
  blocks,
  identity,
}: {
  blocks: CmsBlock[]
  identity: SiteIdentity
}) {
  const visible = blocks.filter((b) => b.visible !== false)
  return (
    <>
      {visible.map((block) => (
        <RenderOne key={block.id} block={block} identity={identity} />
      ))}
    </>
  )
}

async function RenderOne({ block, identity }: { block: CmsBlock; identity: SiteIdentity }) {
  const data = block.data ?? {}
  switch (block.type) {
    case "hero":
      return <HeroBlock data={data} identity={identity} />
    case "stats":
      return <StatsBlock data={data} />
    case "value-props":
      return <ValuePropsBlock data={data} />
    case "features":
      return <FeaturesBlock data={data} />
    case "feature-demo":
      return <FeatureDemoBlock data={data} />
    case "how-it-works":
      return <HowItWorksBlock data={data} />
    case "clients":
      return <ClientsBlock data={data} />
    case "testimonials":
      return <TestimonialsBlock data={data} />
    case "cta":
      return <CtaBlock data={data} />
    case "faq":
      return <FaqBlock data={data} />
    case "pricing":
      return <PricingBlock data={data} />
    case "contact-form":
      return <ContactBlock data={data} />
    case "text":
      return <TextBlock data={data} />
    case "text-image":
      return <TextImageBlock data={data} />
    case "cards":
      return <CardsBlock data={data} />
    case "logos":
      return <LogosBlock data={data} />
    case "custom-html":
      return <CustomHtmlBlock data={data} />
    default:
      return null
  }
}
