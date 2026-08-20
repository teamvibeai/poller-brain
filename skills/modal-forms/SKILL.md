---
name: modal-forms
description: |
  Send interactive Slack modal forms (multi-field input dialogs opened from a button)
  and handle their submissions. Use when a request needs structured, multi-field input
  from the user rather than free text — ratings, forms, multi-option choices.
---

# Modal Forms

You can send interactive forms (Slack modals) to users. Include a `modals` array in `send_message`:

## Sending a Modal

```json
{
  "text": "Please fill out this form:",
  "modals": [{
    "label": "Fill Out Form",
    "callbackId": "feedback_form",
    "view": {
      "type": "modal",
      "title": { "type": "plain_text", "text": "Feedback" },
      "submit": { "type": "plain_text", "text": "Submit" },
      "close": { "type": "plain_text", "text": "Cancel" },
      "blocks": [
        {
          "type": "input",
          "block_id": "rating_block",
          "element": {
            "type": "static_select",
            "action_id": "rating",
            "options": [
              { "text": { "type": "plain_text", "text": "Great" }, "value": "great" },
              { "text": { "type": "plain_text", "text": "OK" }, "value": "ok" },
              { "text": { "type": "plain_text", "text": "Poor" }, "value": "poor" }
            ]
          },
          "label": { "type": "plain_text", "text": "Rating" }
        },
        {
          "type": "input",
          "block_id": "comments_block",
          "element": { "type": "plain_text_input", "action_id": "comments", "multiline": true },
          "label": { "type": "plain_text", "text": "Comments" },
          "optional": true
        }
      ]
    }
  }]
}
```

The user sees a message with a button. Clicking it opens the modal form. When submitted, you receive a `modal_submission` message with the field values. If dismissed, you receive a `view_closed` message.

## Multiple Modals

You can attach multiple modals to one message — each gets its own button:

```json
{
  "text": "Choose an action:",
  "modals": [
    { "label": "Quick Feedback", "callbackId": "quick", "view": { "..." : "..." } },
    { "label": "Detailed Report", "callbackId": "detailed", "view": { "..." : "..." } }
  ]
}
```

## Tips

- Use `callbackId` to identify which form was submitted when you have multiple modals
- The `view` object follows standard Slack Block Kit modal format — use `input` blocks for form fields
- Each input block needs a unique `block_id` and the element needs an `action_id` — these become the field names in submission data
- The `action_id` values from your input elements become the keys in the submission values
