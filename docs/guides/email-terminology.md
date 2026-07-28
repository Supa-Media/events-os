# Email terminology — the words we use, and why

The vocabulary for the Campaigns desk. Every label in the UI, every field
name in the schema, and every Academy lesson uses these words and only these
words. Where we had a word of our own invention, it is retired here.

The test we applied: **would someone who has used Mailchimp, Klaviyo, HubSpot
or Braze recognise this word and be right about what it does?** A designer
joining Public Worship has almost certainly used one of those. Inventing
vocabulary costs them a re-learn for no gain, and it costs us every time we
try to read our own docs against an industry article.

## The nouns

| Our word | Industry word | What it means here |
| --- | --- | --- |
| ~~Audience~~ → **Segment** | Segment | A saved set of RULES that resolves to people at send time ("gave in the last 90 days AND is in Manchester"). Dynamic — its membership changes as the data changes. |
| *(new)* **List** | List | An explicit, hand-held set of people. Static — someone put them in it. We did not have this concept; "Audience" was doing both jobs and the ambiguity is exactly why membership counts surprised people. |
| ~~Skip list~~ → **Exclusions** | Exclusions / Suppression rules | Segments or lists subtracted from the send. "Skip list" read like a synonym for the suppression list, which is a different, non-negotiable thing. |
| ~~Group~~ → **Rule group** | Condition group | A parenthesised bundle of conditions inside a segment. "Group" collided with people-groups. |
| **Suppression list** | Suppression list | Org-wide, never bypassable: unsubscribes, complaints, hard bounces. Not a segment, not editable as one. |
| ~~contact~~ → **Subscriber** | Subscriber / Profile | A person *in their email capacity*. "Contact" stays for the CRM sense; a subscriber is the emailable projection of one, and only a subscriber has a consent state. |
| **Campaign** | Campaign | **One email, sent once, to a chosen audience.** Kept deliberately singular — see below. |
| **Template** | Template | A saved, reusable document. The starting point a campaign is created from. |
| **Theme** | Brand / Design tokens | The colours, fonts, radius and tracking a document renders with. Owned by the designer, changeable whenever she wants. |
| **Block** | Block / Content block | One row of the document (heading, card, banner, footer…). |
| **Recipient** | Recipient | One person's copy of one campaign, with its own unsubscribe token and delivery state. |
| **Merge tag** | Merge tag | `{{firstName}}` — Mailchimp's exact term. |
| **Subject line** / **Preview text** | Same | Unchanged; both already match. |
| ~~blast~~ → **Event announcement** | Announcement | The one-off send attached to an event. "Blast" is an internal joke word that had leaked into UI copy, and it describes the compliance posture we are trying not to have. |
| ~~Deny~~ → **Reject** | Reject | The approver's negative decision. "Deny" reads like a permissions error. |
| ~~"Send as"~~ → **From** | From name / From address | It is the `From:` header. Say so. |

## The one modelling decision worth stating plainly

**A campaign is one email.** It is *not* a container that holds several emails.

This is the point where the industry genuinely disagrees with itself —
Mailchimp's "campaign" is one email, Braze's is a multi-step journey — so we
had to pick, and picking the smaller unit is right for us:

- Every existing table (`campaignRecipients`, approval state, snapshot hash,
  poll votes) is already keyed one-to-one to a single send. Re-modelling
  campaign-as-container would be a schema migration bought with nothing.
- Two-party approval approves **a specific rendered document**. A container
  makes "what was approved?" ambiguous, which is the one question this
  product cannot be vague about.
- The real need behind "emails within a campaign" — *don't start from scratch
  every month* — is what **templates** are for, plus the send history that
  lets you duplicate last month's and edit it.

So: **Template → Campaign → Send.** If we ever need true multi-step (a drip
series, a welcome sequence), that arrives as a new noun — **Flow** or
**Journey**, both industry-standard — and does not retrofit onto Campaign.

## Opt-out: what we hold ourselves to

This is not a preference. It is CAN-SPAM (US), GDPR/PECR (UK/EU), and
Google/Yahoo's February 2024 bulk-sender rules, which are enforced by
*delivery failure* rather than by a regulator, and therefore bite first.

1. **Every bulk email carries a working one-click unsubscribe from send #1.**
   Not "coming soon". A send that cannot be unsubscribed from is a defect
   that blocks the send, not a warning.
2. **`List-Unsubscribe` + `List-Unsubscribe-Post` headers (RFC 8058).**
   Required by Google and Yahoo for bulk senders. Gmail renders its own
   Unsubscribe button from these, and its absence is scored against the
   sending domain.
3. **A visible unsubscribe link in the footer too.** The header is for the
   mail client; the link is for the human.
4. **Unsubscribing is one click — no login, no "are you sure", no survey.**
   Anything that asks the user to authenticate first is non-compliant in
   practice even where it is arguably legal.
5. **GET reads, POST writes.** Mail scanners and link-protection services
   prefetch every `href` in an email. An unsubscribe that acts on GET will
   silently unsubscribe people who never clicked. The link opens a
   confirmation page; the page POSTs.
6. **Honoured immediately** — in practice at the next send, and always well
   inside CAN-SPAM's 10 business days.
7. **A physical postal address in the footer of every bulk email.** CAN-SPAM
   requires it. This is org configuration, and a missing address blocks the
   send rather than sending without it.
8. **Suppression is org-wide and permanent by default.** An unsubscribe,
   spam complaint, or hard bounce suppresses the address everywhere, across
   chapters. A chapter cannot email someone who opted out of another
   chapter's mail — because from the recipient's side it is the same
   organisation, and from Gmail's side it is the same sending domain.
9. **Transactional email is never gated by any of this.** Verification codes,
   receipts, approval requests and password resets are not marketing and
   carry no unsubscribe. Conflating the two is how organisations end up
   unable to send a receipt to someone who left a mailing list.
10. **Re-subscribing is the person's own act.** Staff can un-suppress a
    bounce (an address that has since been fixed) but must not un-suppress
    an unsubscribe or a complaint on someone's behalf.

**Not yet built, and named here so it isn't reinvented under another word:**
a **preference centre** (per-topic subscriptions — newsletter vs events vs
giving, so the choice is "less mail" instead of "no mail"), and a `List-ID`
header. Both are standard; both are the next rung, not this one.

## Renaming rules

- The words above are the UI's words. Schema field names follow where the
  cost is a rename and not a migration; where a stored field keeps an older
  name for migration safety, it carries a comment pointing here.
- Renaming a concept is a **user-facing vocabulary change**, so it triggers
  the Academy rule in `CLAUDE.md`: grep the academy content for the old term
  in the same PR.
