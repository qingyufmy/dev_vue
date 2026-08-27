# Max-thinking transport pilot

These records are an operational pilot, not part of the primary 2x2 language-effect estimates.

- Model: `deepseek-v4-pro-0813`
- Mode: `thinking.type=enabled`, `reasoning_effort=max`
- One ZH-ZH response succeeded after a 120-second network timeout and a second 83.5-second attempt.
- ZH-EN and EN-ZH encountered repeated 120/240-second network timeouts or interrupted in-flight requests.
- Provider billing for requests without an HTTP response is unknown.

The primary 2x2 run uses the same model, frozen inputs, prompts and schema variants with thinking disabled and temperature 0, so transport tail latency does not dominate the language comparison.
