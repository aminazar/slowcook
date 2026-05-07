<!--
Title alternatives, in case "Two stoves around the flame" doesn't land:
  - "Slowcook"
  - "Building a harness for the flame"
  - "Seventeen days inside the harness"
  - "What the tests lock in"
Pick whichever you prefer — the post body works under any of them.

Replace these placeholder URLs before publishing:
  [standard-code] — your "Standard Code" post (April 18)
  [naked-flame]    — your "vibe-coding is like cooking on a naked flame" post

LinkedIn won't render the markdown formatting, but the structure carries
through if you copy as plain text — pull quotes will read as their own
short paragraphs, and the body flow stays intact.
-->

# Two stoves around the flame

A few weeks ago [I argued on this feed][standard-code] that AI is doing to code what kerosene did to whale oil — turning a bespoke, expensively produced thing into a standard, predictable one. I felt good about the argument. I left the harder question untouched: how do you actually do that in practice? How does a small team get LLMs to produce reliable, predictable, shippable code without the result feeling like cooking on a naked flame?

I spent the last seventeen days trying to find out. The thing I ended up building is called slowcook. This is the post about what I learned.

In simple terms, slowcook is a tool that takes a feature request — written as a normal GitHub issue, the kind you and I write every day — and walks AI agents through producing the actual production code. There's a step where one agent works with a human product manager to turn the issue into a clear, structured specification. Another step where a separate agent writes the tests that codify what "done" looks like. Another step where a third agent writes the real code, in a tight loop where every iteration has to keep all the tests passing before the work can advance. The human stays in the loop the whole time, reviewing pull requests and leaving comments the way they would with any team of developers.

The thing worth saying up front, because it surprises both technical and non-technical people I've shown this to: there is no fancy agent framework underneath. No langchain, no autogen, no graph of stateful agents passing tokens around inside some long-running runtime. The orchestration layer is GitHub itself. Each agent runs as a workflow, gets triggered by something visible — a label, a merge, a slash command in a comment — and posts its output as a pull request that the next agent or a human reacts to. The harness lives in the choreography of GitHub primitives every developer already knows. There is nothing additional to install. Nothing extra to corrupt. Every step is visible to humans at every stage.

The first surprising thing was the cost.

When I started this, getting an AI to ship a whole feature autonomously cost me ten to twelve dollars per attempt, and most attempts never converged. Within a couple of weeks of building the harness, the same kind of feature was costing one to two dollars and shipping reliably. The unlock wasn't a bigger or smarter model. It was attention. Once we had the basic loop working, the question wasn't "can the model do this" but "how do we stop the model from re-reading the entire codebase on every iteration just because it's anxious about missing something." We started feeding it a code map up front so it knew the shape of the project. We started slicing the context per iteration so it only saw the parts of the code that mattered to the failing test in front of it. We surfaced the specific failure messages instead of dumping logs at it.

> "Attention is all you need" was originally a paper title about the architecture inside the model. It turns out it applies just as much to the harness around the model.

Cost dropped roughly five-to-tenfold — without changing models, without changing the underlying logic, just by being more careful about what we let the agent look at.

The second thing I learned, painfully, was that prompts don't work as enforcement.

Across the first couple of weeks, every assumption I had about what the agent would do "if I asked nicely in the system prompt" failed in some new and embarrassing way. The agent shipped a screen with no visual styling at all — functionally correct, accessible, all tests passing, completely unusable to look at. The agent shipped a feature whose component was never imported into the page where it was supposed to live, so visiting the page showed nothing while every test still passed. The agent referenced database columns that didn't exist in any migration. Each time my instinct was "I'll fix it in the prompt." Each time the prompt fix worked for one or two runs and then quietly stopped working.

The pattern took me embarrassingly long to internalize. The agent is optimizing one signal hard: the tests passing. Anything you ask for in a prompt that doesn't show up as a failing test is, to the agent, a low-priority hint it can ignore under pressure. Every time I caught myself writing "the agent should remember to do X" in a prompt, the right move was to write a test that fails when X is missing.

> Move the requirement out of the paragraph and into the contract.

After three rounds of learning this — once each for missing styling, missing page hook-ups, missing database columns — I stopped trying to reason the agent into doing the right thing and started locking the right thing into the test suite by default. The pipeline got more boring. It also got reliable.

Then I made a different kind of mistake, and the way I crawled out of it became the most useful idea in the project.

I'd been thinking about the harness from one direction the whole time: how do I get the agent to do the right thing in production code? But the agent is actually good at one specific thing — visual design — when it isn't also trying to wire up data and routes and database queries at the same time. So I built a separate playground for that part. Instead of giving the product manager a Figma file or a static screenshot to comment on, I let the agent vibe-code an actual working mock-up of the feature. Real components, real interactions, no real data. The PM can click around, navigate the screens, see how the thing actually behaves. Then I added a review layer on top of it — almost exactly the way Figma lets you leave comments anchored to a specific element on the canvas, except this is anchored to a specific element on a live running web app. The PM marks up the mock; another agent reads the comments and amends the mock to apply the changes. Once the PM approves, a deterministic step copies the approved design into production and the implementation agent wires real data behind it.

This is a direct nod to [that earlier post I wrote about LLMs being like a naked flame][naked-flame]. Slowcook now has two stoves, not one. The first is the test suite, the hard signal that locks in behaviour for production code. The second is the mock-with-review-layer, the signal that lets a human keep the agent honest about design intent.

> Tests for the parts that have correct answers; humans looking at rendered UI for the parts that don't.

The agent's strength gets used where it belongs. Its weakness gets controlled where it matters.

I should also be honest about a hypothesis I tested that didn't work, because the negative result is what shaped what came next.

There is a long-running argument among developers about whether strictly typed languages are worth the trouble. The case for them: the compiler catches whole classes of bugs before the code even runs, and the types document intent. The case against: it's easy to over-engineer, you spend energy modelling abstractions instead of solving the actual problem. I had a hypothesis that fit cleanly into the pro-types camp. If I could automatically extract a project's data model into a single shared, formal definition and point every agent at it, the recurring "the spec calls it `profile`, the mock calls it `owner`, the tests call it `viewer`" drift would just die. The compiler would enforce what was previously a soft signal. Two days of work to build it. Three real runs against it.

The agents ignored it completely. None of them imported anything from the shared definition I'd built. It turned out they don't reason at the level of the whole data model. They reason at the level of one specific component at a time, using whatever subset of fields that component happens to need. Pointing them at a project-wide abstraction was, to them, just another low-priority instruction. The formal definitions sat there unused while the agents continued naming things however they felt like in each individual file.

That negative result was the most valuable thing the typed-entity work produced. It told me to stop investing in project-level abstractions and start investing in component-level context. Both of the genuinely interesting ideas in slowcook came directly out of that pivot.

The first is pair programming. If a single agent will always ignore some quiet, important constraint, the answer is to give it a partner whose entire job is to watch what it does. One agent writes code; a second agent reviews each iteration before it gets committed, looking for the kinds of things tests can't catch — design fidelity against the approved mock, cross-feature impact, accessibility, the kind of judgment a senior engineer applies in code review. It works. It costs a few cents extra per iteration. It catches issues the test suite genuinely cannot catch by itself.

The second is what I think of as a micromanaging editor that runs after the fact, when the multi-step pipeline drifts. Stories typically involve four or five pull requests open at once — the spec, the tests, the mock-up, the implementation. If a name or a prop shape changes in one of them, the others quietly fall out of sync, and the next agent in the chain halts because nothing matches anymore. Instead of dispatching another expensive agent to retry the whole job, this editor (we call it "chef") makes small, surgical edits across the affected pull requests to bring them back into alignment. Like a senior developer going through quietly fixing the inconsistencies that would otherwise eat your afternoon. A whole drift-fix happens for a few cents and the pipeline keeps moving.

> Both of these were ideas I would not have arrived at if the typed-entity hypothesis had worked. The failure was the thing that pointed at them.

What I am willing to claim, after seventeen days of doing this: building with autonomous AI agents is mostly the work of figuring out where the agent's strength belongs and putting the right harness around it. Tests for code correctness. A live mock with human review for design correctness. A reviewer agent for the things tests can't see. A surgical editor that fires only when the pipeline halts — it reads what the reviewer flagged and makes small corrective edits across the in-progress pull requests to bring them back into alignment, cheaper than discarding the work and dispatching a fresh attempt. None of these tools are the agent itself. They are the stoves and pans we put around the flame.

Most teams I see still building with agents without harnesses around them end up where I started: ten dollars a try, results that are occasionally great and unpredictably so. Brilliant some days, incoherent on others, never something you can plan a quarter around. That gap — between work that's sometimes shippable and work that's reliably shippable — is the whole difference between a demo and a standard product.

> Not better on its best day, but the same on every day.

Which is, more or less, the entire premise of the [Standard Code post][standard-code] I started this from.

If you have a real codebase you'd want to try this kind of harness on, slowcook is on npm — `@slowcook-ai/cli` under the alpha tag — and the repo is at [github.com/aminazar/slowcook](https://github.com/aminazar/slowcook). What the project needs most right now is people running it on real codebases beyond mine and filing bugs when it breaks. Every reported failure becomes a test that locks slowcook against making the same mistake again — the same trick the harness pulls on the agents, applied to itself. If you've tried it, or want to talk through whether it'd fit your project, message me.

[standard-code]: REPLACE_WITH_STANDARD_CODE_POST_URL
[naked-flame]: REPLACE_WITH_NAKED_FLAME_POST_URL
