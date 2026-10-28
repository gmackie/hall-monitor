# U.S. moderation timing — evidence register and benchmark limits

**Research snapshot: 2026-10-28.** The U.S. has no verified representative public, cross-platform **hour-of-day × day-of-week moderation activity** dataset spanning school chat, social media and platforms generally. The sources below differ in geography, covered population, event unit, detection/reporting mechanism and time-of-event. **Never pool these values into an empirical national hourly curve.**

## 1. Evidence ladder

| Source | Period and coverage | What timestamp/metric means | What it does NOT establish |
|---|---|---|---|
| [Gaggle 2021–22 report, PDF p.11](https://images.g2crowd.com/uploads/attachment/file/1288126/Through-the-Gaggle-Lens---The-State-of-Student-Safety---2021-22---REPORT.pdf) | School accounts/devices covered by Gaggle, July 2021–June 2022 | Vendor-detected **incidents** by day of week and school/after-hours | National incidence rate of bullying, all students, all U.S. moderation or when humans performed reviews |
| [North Carolina reporting study, Injury Prevention 2026](https://pmc.ncbi.nlm.nih.gov/articles/PMC13430530/) | 44,998 anonymous/confidential youth tips, Nov 2019–May 2025 | **Submitted reports** by weekday/hour, concern and life-threat classification | Timing of underlying content creation, model calls, or general U.S. behavior |
| [Gaggle 2024–25 report](https://news.gaggle.net/student-safety-report-2025) | Vendor-monitored content in participating schools | Annual items analyzed, reviewed, resulting incidents and emergency calls | Hourly distribution or independent false-positive/recall benchmark |
| [Gaggle 2025–26 report](https://news.gaggle.net/2026-ssr) | More recent vendor report and commissioned external validation | Classification study and emerging categories | Representative U.S. hourly rates or production population precision from small curated samples |
| [Reddit H2 2025 transparency](https://redditinc.com/policies/transparency-report-july-to-december-2025-reddit) | Worldwide public platform | Admin/community moderation removals and share of automated mod removals | U.S.-only hourly moderation staffing/activity or school bullying |
| [Cheng et al., CSCW 2017](https://pmc.ncbi.nlm.nih.gov/articles/PMC5791909/) | 16M+ CNN comments and controlled experiment | Flagged antagonistic comments and social-context/daytime patterns | Representative adolescent or modern platform incident curves |

Evidence strength must be labeled per panel: observed vs inferred; vendor marketing vs independent data; population; actual year; confidence/uncertainty; metric and time definition. “U.S.” refers to scope of study, not a license to extrapolate nationally.

## 2. Gaggle 2021–22 day of week and after hours

From PDF printed page 11 (PDF zero-index 10), visually verified:

| Sunday | Monday | Tuesday | Wednesday | Thursday | Friday | Saturday |
|---:|---:|---:|---:|---:|---:|---:|
| 5% | 17% | 19% | 19% | 18% | 17% | 5% |

The same figure labels **65% school day, 35% after hours**. Its footnote defines after-hours as weekdays 5 PM–8 AM and weekends. This is a distribution of **vendor-detected student safety incidents within its covered school accounts**, not the rate per message or the times when a reviewer took action. The hourly curve in the figure is graphic without published hourly table; do not invent 24 numeric points from its shape.

Use cautiously for **illustrative staffing scenarios only** and always label historical source and vendor selection. The distribution need not hold for any individual district, EducateOS, or 2026 platforms.

## 3. North Carolina 2026 reporting study

Thulin et al., *Timing patterns of interpersonal violence, mental health and school attack tips submitted by youth to a statewide anonymous reporting system*, *Injury Prevention*, published March 2026. Data: 44,998 tips, Nov 2019–May 2025. Main peer-reviewed observations from the [full PMC text](https://pmc.ncbi.nlm.nih.gov/articles/PMC13430530/):

- Wednesday average ~29.7 tips/day and Thursday ~30.6; Saturday ~7.2 and Sunday ~7.5.
- Most total submissions occurred 10:00–14:59 (~1.6–1.9 per hour averaged over study period).
- Interpersonal violence tips most frequent during roughly 08:00–17:59, while mental-health and school-attack tips clustered later in evening (~20:00–22:59).
- Highest **fraction** of tips classified life-threatening: 42.2% at midnight–00:59; lowest 6.95% at 13:00–13:59. Absolute late-night tip volume was much smaller.
- Weekend life-threatening **share** was ~30.8% Saturday and ~37.3% Sunday.
- Reports varied seasonally; most average monthly tips in October and March, much fewer in summer.

The **conditional severity proportion among tip submissions** is not the probability that a random late-night chat message is dangerous. This distinction is non-negotiable. The study documents a particular tipline, participation and reporting-channel behavior, not total occurrence of bullying or harassment. It helps design on-call availability and urgency triage, not student suspicion weights.

## 4. Vendor funnel and newer external validation

Gaggle [2024–25 report](https://news.gaggle.net/student-safety-report-2025) says nearly 6.9B pieces of content analyzed, >8.7M items human reviewed, 482,203 incidents requiring district attention and 26,855 emergency phone calls. Using rounded values, human-reviewed/analyzed is approximately 0.126%; this is a **vendor-specific funnel**, not Hall Monitor's target review rate or a probabilistic safety prevalence. Calls, incidents and reviews may refer to different workflows and units.

The [2025–26 report page](https://news.gaggle.net/2026-ssr) describes an evaluation commissioned with NC State's Friday Institute. Gaggle reports **3 false positives among 355 safe items from two earlier evaluation runs (0.84%)**, noting that the final run did not include safe content and its false-positive rate there was not available. This specific statistic does not establish recall, broader production false-positive performance or school population outcomes. Track the original study methods if available before using it for vendor comparisons.

## 5. Other U.S. public platforms

[Reddit's H2 2025 report](https://redditinc.com/policies/transparency-report-july-to-december-2025-reddit) counts 154,198,211 removed posts/comments. Community moderator removals were 68.6% automatic. These removals include spam, off-topic and formatting rules, as well as harm and policy violations; data are **global**, not U.S.-hourly. No denominator of all U.S. student chats.

[Cheng et al. (2017)](https://pmc.ncbi.nlm.nih.gov/articles/PMC5791909/) studied >16M CNN comments and found contextual exposure to trolling mattered, with late-night/Monday patterns. These are historical discussion-platform data; the mechanism motivates *conversation context modeling*, not personal late-night risk multipliers or national school staffing estimates.

## 6. Research design for eventual opt-in U.S. benchmarks

Before any aggregate study:
- Districts opt in via explicit governance, legal basis and meaningful notices, with prohibited uses and a published data dictionary.
- Never collect individual messages/identities across districts. Use fixed coarse dimensions and school-local time; count eligible message exposures and coverage.
- Measure at least three timestamps/curves separately: creation/evaluation, reporting, and qualified review/action. Include unresolved cases and delays.
- Stratify sources: school-managed chat vs voluntary tipline vs public platform; don't combine incomparable event units.
- Capture time zone, DST, calendar state, deployment model/policy revision, intervention changes, late arrival, missing data and exposure denominator.
- Sample participating districts to assess representativeness and demographic/size/geographic bias without creating identifiable small cells.
- Publish uncertainty and selection caveats; suppress small populations and protect against overlapping difference queries. Differential privacy may be appropriate for public cross-district publication; design and evaluate a formal privacy budget rather than calling a fixed k threshold sufficient.
- External vendor statistics serve as historical **context**, not priors fed into student safety decisions. District-specific operational data should calibrate staffing needs while keeping urgent safety thresholds independent of hour.

## 7. What we do *not* know yet

We do not know the nationally representative number of U.S. messages evaluated, incidents opened, volunteers reporting, paid moderators reviewing or harmful posts per hour. No publicly verified 168-cell U.S. joint table is available from this research. We do not know the exact ratio of after-hours **human review actions** to after-hours **harm occurrences**, nor the staffing SLO of any independent district using Hall Monitor.

Avoid inventing those numbers; instead make temporal analytics a measurable, governed component of our own district deployment and distinguish observed data from synthetic scenario simulations.
