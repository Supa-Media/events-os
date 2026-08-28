import { MailingListView } from "../../../components/marketing/MailingListView";

/** MAILING LIST tab — who the org can reach on email and SMS, who asked not to
 *  be, and the public sign-up link. Body in
 *  `components/marketing/MailingListView.tsx`, which resolves its own access:
 *  this tab DOES have a read-only mode (`canViewList` without `canEditList`)
 *  and the view is where that split is expressed, row by row. */
export default function MailingListScreen() {
  return <MailingListView />;
}
