Produce a finished video with the **lemo-opuscar** skill. This is an automated, unattended run: nobody can answer questions, so never ask any (do not use AskUserQuestion) and never wait for a reply. The brief below is complete; fill every other gap with a sensible default.

## Using the skill
- The skill's instructions are in `{{skill_dir}}/SKILL.md` — read it first and follow it. Its base directory is `{{skill_dir}}`.
- The style library is at `{{lib_dir}}` (run the skill's `setup.sh` as SKILL.md says; it prints `LIB=`).
- The user's language is {{language}} — skip the language question and the "ways in" question.
- The project folder for this film is `{{film_dir}}` (already the name to use; the guides' `films/<name>/` means this folder).
- Brief round of questions: already answered here. Storyboard review: no.

## Brief
- Style: `{{style}}` (from the Lemo-Opuscar library).
- Topic and script: read `{{video_dir}}/script.md` and `{{video_dir}}/metadata.json`; facts and sources are in `{{video_dir}}/research.md`. Use the script's narration as the voiceover text.
- Length: {{duration_sec}} seconds (±10%). Aspect ratio: {{aspect_ratio}} — use {{resolution}}.
- Voiceover: {{voice}}.
- Music: {{music}}. Subtitles burned in: {{captions}}. Language: {{language}}.
{{production}}
{{extra_skills}}
- No material of the user's own: draw or generate everything; no real brands, logos or people's likenesses.
- Notes from the owner: {{notes}}

{{revision}}

{{resume}}
## Work economically
This run shares a limited usage budget, and everything you print is re-read on every later turn. Quality stays the same; waste goes:
- Never print long output. Send installs, renders and searches to a log file and show only what you need (`> /tmp/x.log 2>&1; tail -n 15 /tmp/x.log`). Use `head`, `tail`, `grep` or `wc` instead of `cat` on anything long.
- Read each guide once, and only the sections you need. Do not re-read files you wrote yourself.
- Combine related commands into one call, and write a file in one go rather than through many small edits.
- When searching for assets, print at most ten short result lines (title and URL), not raw API responses.
- Check frames by looking at one contact sheet per render instead of many separate images.
- Do not narrate between steps; act.

## Delivery
Deliver everything DIRECTOR.md §11 lists in `{{film_dir}}`, with the film named `film.mp4`, plus `poster.jpg` and `film.srt` (when there is narration). Run the skill's checks (loudness about −14 LUFS, no black frames, subtitles in sync) before finishing.

If a tool or package is missing and you cannot install it inside the project or library folders, stop and say exactly what is missing in your final message — do not install system software.

Finish with one line: the path of the finished film.
