# Pulpit Engine

A service that takes a church's recorded sermon, finds the best moments, makes short captioned clips, and posts them to the church's social pages across the week. This glossary fixes the words we use for the product. It is not a spec.

## Language

### The product

**Pulpit Engine**:
The product, and the name of this code base. The final name for everything the church sees.
_Avoid_: Sermon Clipper, the clipper, the tool, SC

**First build**:
Jake's first version of Pulpit Engine, in the `pulpit-engine` folder next to this one. Its code is retired. Some of its live pieces carry over.
_Avoid_: old Pulpit Engine, PE v1, legacy

### The customer

**Church**:
A church that pays a monthly fee to have its sermons turned into clips and posted.
_Avoid_: workspace, customer, account, user, client

**Service**:
One weekly meeting where a sermon is preached, for example Sunday morning or Wednesday night.
_Avoid_: slot, occurrence, stream

**Sermon**:
The recorded video of one service. The source that every clip comes from.
_Avoid_: source video, recording, project, upload, message

### Getting the sermon

**Intake**:
The way a sermon gets from the church to the system. The desired outcome is automatic intake.
_Avoid_: send us, submit, ingest

**YouTube import**:
Intake where the system pulls the sermon from the church's YouTube channel on its own. The first automatic intake.
_Avoid_: scrape, download, proxy import

**PERC**:
Intake where the church's streaming tool pushes a copy of the sermon to us while it streams. The long-term automatic intake.
_Avoid_: Cloudflare Stream, live input, push

**Direct upload**:
Intake where a person at the church uploads the sermon file by hand. The fallback.
_Avoid_: manual upload, file drop

### Making clips

**Candidate**:
A moment in a sermon that the system thinks could become a clip. Not yet chosen.
_Avoid_: window, segment, moment, highlight

**Clip**:
A short captioned video cut from one sermon, chosen for posting.
_Avoid_: export, reel, short, render, highlight

**Reserve**:
A candidate kept back, in rank order, to take the place of a clip that is rejected.
_Avoid_: backup, spare, alternate

**Swap**:
Putting the next reserve in the place of a clip that failed the quality bar, before it posts.
_Avoid_: replace, replacement, fill

**Non-sermon content**:
Any part of a service where the preacher is not preaching: announcements, worship, prayer, altar call, baptism, offering.
_Avoid_: forbidden region, filler, noise

**Quality bar**:
The four tests a clip must pass before it posts: starts and ends on time, the preacher is preaching, the video shows the preacher the whole time, and it is engaging.
_Avoid_: editorial standard, acceptance criteria, rubric

### Posting and checking

**Sandbox page**:
A real Facebook page that we own, named "First Baptist Sandbox", where test clips post so no church member sees them.
_Avoid_: test page, demo page, First Baptist Demo, Tier 3 sandbox

**Hands-off posting**:
Clips post to the church's social pages with no person checking them first. The desired end state.
_Avoid_: full auto, autonomous, autopilot

**Church check**:
One person at the church approves the week's clips before they post. The default setting until the church turns it off.
_Avoid_: review, approval flow, moderation

**Proving period**:
The time when Jake checks every clip for the first churches to confirm the quality. It ends when the clips meet the quality bar.
_Avoid_: 30-day phase, human-only phase, pilot, beta
