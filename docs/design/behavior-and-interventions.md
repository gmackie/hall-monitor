# Relational aggression, platform abuse and prosocial interventions

**Status: design and safeguarding research, not implemented student-facing behavior.** Hall Monitor currently returns allow/coach/hold/block/support decisions for evaluated content, but does not own the chat UI, moderation permissions, notifications, or a persistent incident graph. The originating product executes all interventions and is accountable for accessible, age-appropriate design.

## Threat model: students may exploit *both* social norms and moderation controls

| Pattern | Candidate evidence | Misclassification danger | Proportionate first response |
|---|---|---|---|
| Direct insults or threats | Content + recipient + context | Sarcasm, quotation, victim report | Hold/review high-risk threats; optional rewrite nudge for ordinary hostility |
| Rumor spreading / gossip | Re-sharing of personal allegation, coordinated amplification | Unverified claim may be true or a good-faith help request | Pre-forward friction, no automatic truth/defamation finding |
| Group exclusion | Coordinated requests to deny access to a student, repeated removal from required group | People may choose their friends and optional social groups | Verify mandatory group membership; restore legitimate access, coach group norms |
| Ignoring / silent treatment | Explicit coordination instructions, pattern of denial of required interaction | No one owes another student replies or friendship | Do not treat ordinary nonresponse or personal blocking as a violation |
| Dogpiling / pile-on | Several accounts converge on one student with hostile content | Multiple independent legitimate objections | Slow-mode / stop mentions; review context |
| Spam / flood / unwanted contact | Sliding-window message counts, duplicates, mention bursts, repeated contact after block | High-message-rate accessible communication needs, urgent help | Deterministic rate limit, protection, nonpunitive feedback |
| Report brigading | Near-simultaneous reports with same source and timing | Legitimate mass reporting after a public incident | Deduplicate and evaluate evidence; report volume alone never punishes |
| Bait-and-report | Provocation followed by selective complaint | Genuine abuse may precede a legitimate report | Review a bounded preceding timeline and counterevidence |
| Weaponized group mute | Delegated role mutes/removes one person repeatedly or disproportionately | Good-faith student moderators enforcing published rules | Audit permissions, restrict delegated power if abuse is corroborated |
| Block evasion / impersonation | Contact attempts after protected boundary, verified alternate identity evidence | Coincidental aliases or mistaken identity | Protective block enforcement; restricted review |
| Harassing image or meme | Visual targeting, caption and redistribution | Educational imagery; misidentified subject; manipulated media | Pre-forward nudge and appropriate image safety route |
| False allegation / screenshot forgery | Contradictory provenance or altered media | Incorrect “false reporter” designation can chill help-seeking | Independent verification and human review |

**The user's personal mute/block is not an incident signal.** It is a privacy-preserving right. The operational signal is the *violation of* a contact boundary or **someone else's** delegated permission change with legitimate audit purpose.

## Event classes worth collecting only when justified

Current content.request and findings stay as they are. A separate source integration may emit purpose-limited **actions**: message.sent/edited/deleted, mention.created, group.member_removed, group.permission_changed, report.submitted, group_mute.applied, moderation.reversed, contact_boundary.evasion. For each action record the source policy, scope, minimal identities in keyed tenant pseudonyms, age/authorization basis, permitted retention, and linked evidence reference. Don't persist passive friendship or personal mute preferences into the incident graph.

## Intervention hierarchy (not an escalating punishment counter)

0. **Observe and expire:** ordinary opinion, low-risk disagreement, no retained dossier.
1. **Private reflective nudge:** optional pre-send/forward text focused on potential impact. No accusation, diagnosis or reference to private messages by third parties.
2. **Protective friction:** targeted slow mode, duplicate/forward cap, contact boundary, optional cooling-off; reversible and accessible.
3. **Restricted incident assessment:** designated safeguarding staff receive a minimal, purpose-bound summary; if needed they request specific protected evidence under access policy.
4. **Human safeguarding response:** credible threats, repeated substantial harm or urgent distress trigger trained adult action promptly; involve emergency services where appropriate under adopted response protocols.

The system may **skip levels** for immediate risk. Never require a count of prior incidents before offering human help. Do not automatically discipline, reveal a pseudonym or diagnose a child from scores.

### Nudge language and product UX

| Trigger | Example private prompt | Required escape hatch |
|---|---|---|
| Forwarding a personal allegation | “Sharing an unverified personal claim can spread it further. Do you want to reconsider?” | Edit / continue if allowed / report to adult |
| Hostile reply | “Want a moment to reword this before sending?” | Edit / continue under published rules |
| Exclusion from required group | “If there's a group task problem, consider asking the teacher for help rather than removing a teammate.” | Send a genuine concern to school support |
| Repeated unsolicited mentions | “This person may not welcome more messages. Try giving them space.” | Help path; don't block support-seeking reports |
| Bystander observing harassment | “If someone is being mistreated, you can offer support or tell a trusted adult.” | One-click trusted-adult/report path |

Prompts should be curated by developmental stage, tested for accessibility and available languages, and rate-limited. Do not shame or tell a student “AI knows you're a bully.” Do not disclose the presence of another student's report or private messages. A student's refusal of a nudge is not proof of guilt. Protect students who use profanity in help-seeking or crisis disclosure.

Use the distinct current output decision “support” for immediate supportive UX and never replace human counseling or mandated safeguarding.

## School context: mandatory access versus optional socialization

In an optional friend group, declining an invitation or declining interaction is generally ordinary autonomy. In a required course workspace, removal or targeted inability to participate affects access to learning. Use the source system's *verified group purpose, entitlement and actual access state*, not inferred friendship status.

Differentiate **personal mute**, **delegated group mute** and **institutional safety restriction** in separate interfaces, audit streams and authorization policies. A student must not be able to vote another student into a school-wide mute merely by submitting reports.

## Privacy and students' rights

Conduct processing only in disclosed, authorized school-managed spaces; don't quietly intercept personal texts, personal DMs or counseling channels. Limited content-based nudges should preferably be ephemeral. Aggregate teacher insights only above minimum cohort thresholds and suppress rare/small-population alerts that indirectly identify students. Use separate, tightly approved case review for private evidence.

Victim reports, corroboration and defensive boundary-setting require special treatment to avoid retaliation by the algorithm. Every significant intervention has a way to seek human review, correct a mistaken attribution and restore access.

## Outcome evaluation

Metrics must reflect actual welfare, not clicks: severe incident miss rate; wrongful action rate; safeguarding response time; rate of substantiated events across time; help-seeking completion; accessibility and language fairness; appeal reversals; teacher exposure to private data; student comfort and chilling effects. Pre-send editing rates alone are **not** proof of bullying reduction. Start with formative student and safeguarding-professional review; any live intervention study with minors needs governance, notice and ethical review.

Design references: [FTC-style school privacy boundary](https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions), [StopBullying.gov](https://www.stopbullying.gov/bullying/what-is-bullying), [Meta bullying policy](https://transparency.meta.com/policies/community-standards/bullying-harassment/). The empirical success of any particular nudge requires independent measurement, not transfer of results from Instagram.
