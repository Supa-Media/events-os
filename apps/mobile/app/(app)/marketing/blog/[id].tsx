import { useLocalSearchParams } from "expo-router";
import { MarketingBlogPostEditor } from "../../../../components/marketing/BlogPostEditor";

/** BLOG · one post. `/marketing/blog/new` is the create case — the editor
 *  takes `postId: null` for it and swaps this route for the real id the
 *  moment the post is saved. Body (and gate) in
 *  `components/marketing/BlogPostEditor.tsx`. */
export default function MarketingBlogPostScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <MarketingBlogPostEditor postId={id === "new" ? null : id} />;
}
