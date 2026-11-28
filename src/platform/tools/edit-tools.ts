/**
 * WordPress dependencies
 */
import { __ } from '@wordpress/i18n';

/**
 * Internal dependencies
 */
import type { AiChatRequest, AiEdit, AiEditResult } from '..';
import { endToolRequest, trackRequestText } from './answer-text';
import { runRead } from './read-tools';

/**
 * How many times the model may try again in one answer after a failed edit
 * or read. Reads count too, so a model that keeps asking for blocks that do
 * not exist also stops.
 */
const MAX_RETRIES = 3;

/**
 * The most requests one answer may send to the model. An answer usually
 * takes one to three: the edits, a retry after a failed edit, and a read of
 * the document. The limit stops a model that keeps calling tools from
 * running up the cost.
 */
const MAX_REQUESTS = 10;

/**
 * The tool the model edits the document with, in the shape of Anthropic's
 * Messages API. The other providers convert it to their own shape, so every
 * provider gets the same tool.
 */
export const EDIT_TOOL = {
	name: 'edit_blocks',
	description: [
		'Edits the document in the block editor. Call it once for each change.',
		'"replace" replaces the selected blocks with the markup. "insert_after" without "ref" inserts the markup after the selected blocks, or at the end of the document when nothing is selected.',
		'With "ref", the reference ID of a block in the document, "replace_block" replaces that block, inner blocks included, "insert_before" and "insert_after" insert the markup before or after it, and "delete_block" removes it. "append" adds the markup to the end of the document.',
		'"replace_text" replaces the "find" text, which must appear only once in the document, with the markup, for small changes such as a word or a sentence.',
	].join( ' ' ),
	// Long markup arrives as it is written, instead of all at once at the end.
	eager_input_streaming: true,
	input_schema: {
		type: 'object',
		properties: {
			action: {
				type: 'string',
				enum: [
					'replace',
					'insert_after',
					'replace_block',
					'insert_before',
					'delete_block',
					'append',
					'replace_text',
				],
			},
			ref: {
				type: 'string',
				description:
					'The reference ID of the block to edit, such as "b12", from the <!-- b12 --> before it.',
			},
			find: {
				type: 'string',
				description:
					'For "replace_text", the markup to replace, copied exactly from the document. It may be text inside a block, or whole blocks.',
			},
			markup: {
				type: 'string',
				description:
					'The new content, as block markup. For "replace_text", what replaces "find". Empty for "delete_block".',
			},
		},
		required: [ 'action' ],
	},
};

const APPLIED = 'The edit was applied.';

/**
 * Tells the model its edit was applied, and the reference IDs of the blocks
 * it added, so it can edit them again, and what was fixed in its markup, so
 * it does not write it the same way again.
 *
 * @param refs    The reference IDs of the added blocks.
 * @param autoFix What the automatic fix changed.
 * @return The result.
 */
export function describeApplied( refs: string[] | undefined, autoFix?: string ): string {
	const applied = refs?.length
		? `${ APPLIED } The reference IDs of the new blocks are ${ refs.join( ', ' ) }.`
		: APPLIED;
	return autoFix ? `${ applied }\n\n${ autoFix }` : applied;
}

/**
 * Reads the edit from the input of an `edit_blocks` call.
 *
 * @param input The input.
 * @return The edit, or `null` when the input does not match the tool.
 */
export function toEdit( input: unknown ): AiEdit | null {
	const { action, markup = '', ref, find } = ( input ?? {} ) as Record< string, unknown >;
	if ( typeof markup !== 'string' || ( ref !== undefined && typeof ref !== 'string' ) ) {
		return null;
	}
	switch ( action ) {
		case 'replace':
		case 'append':
			return markup ? { action, markup } : null;
		case 'insert_after':
			if ( ! markup ) {
				return null;
			}
			return ref ? { action, ref, markup } : { action, markup };
		case 'replace_block':
		case 'insert_before':
			return ref && markup ? { action, ref, markup } : null;
		case 'delete_block':
			return ref ? { action, ref, markup: '' } : null;
		case 'replace_text':
			// An empty markup removes the text.
			return typeof find === 'string' && find ? { action, find, markup } : null;
	}
	return null;
}

/**
 * Finds a readable message in an error response from the relay or from
 * Anthropic, or from OpenAI, which answers errors in the same shape.
 *
 * @param response The error response.
 * @return The message.
 */
export async function readErrorMessage( response: Response ): Promise< string > {
	try {
		const body = await response.json();
		// Anthropic: `{ type: 'error', error: { message } }`. WordPress: `{ code, message }`.
		const message = body?.error?.message ?? body?.message;
		if ( typeof message === 'string' && message ) {
			return message;
		}
	} catch {
		// Not JSON, so fall through to the status.
	}
	return `${ response.status } ${ response.statusText }`.trim();
}

/**
 * What the model is told when an edit was not applied because the selected
 * blocks no longer exist.
 */
const DROPPED = 'The selected blocks no longer exist, so the edit was not applied.';

/**
 * What the model is told when its call of the edit tool does not match the
 * tool, unless the provider tells it more.
 */
const INVALID_EDIT = `Call ${ EDIT_TOOL.name } with arguments that match its parameters.`;

/**
 * A tool call of the model, in the same shape for every provider.
 */
export type ToolCall = {
	/**
	 * The call's ID, which its result goes back with.
	 */
	id?: string;
	name?: string;
	/**
	 * The call's input, or when it is not valid JSON, its text.
	 */
	input: unknown;
	/**
	 * Whether the input is not valid JSON.
	 */
	invalid?: boolean;
};

/**
 * What a tool call did: the text that goes back to the model, and whether
 * the call failed.
 */
export type ToolOutcome = { text: string; failed: boolean };

/**
 * Runs a tool call: a read of the document, or an edit, which `onEvent`
 * applies.
 *
 * @param call        The call.
 * @param onEvent     Applies the edit.
 * @param read        Reads the document.
 * @param invalidEdit What the model is told when the edit does not match the tool.
 * @return What the call did, and whether its result must go back to the model.
 */
function runTool(
	call: ToolCall,
	onEvent: AiChatRequest[ 'onEvent' ],
	read: AiChatRequest[ 'read' ],
	invalidEdit: string
): { outcome: ToolOutcome; replied: boolean } {
	const found = call.invalid ? null : runRead( call.name, call.input, read );
	if ( found ) {
		return {
			outcome:
				found.status === 'failed'
					? { text: found.reason, failed: true }
					: { text: found.content, failed: false },
			replied: true,
		};
	}
	const edit = ! call.invalid && call.name === EDIT_TOOL.name ? toEdit( call.input ) : null;
	let result: AiEditResult;
	if ( call.invalid ) {
		result = { status: 'failed', reason: JSON.stringify( { INVALID_JSON: call.input } ) };
	} else if ( ! edit ) {
		result = { status: 'failed', reason: invalidEdit };
	} else {
		result = onEvent( { type: 'edit', edit } ) ?? { status: 'dropped' };
	}
	let outcome: ToolOutcome;
	if ( result.status === 'failed' ) {
		outcome = { text: result.reason, failed: true };
	} else if ( result.status === 'applied' ) {
		outcome = { text: describeApplied( result.refs, result.autoFix ), failed: false };
	} else {
		outcome = { text: DROPPED, failed: false };
	}
	// The model sees the result when the edit failed, was dropped, or had its
	// markup fixed, so it knows the blocks differ from what it wrote.
	return {
		outcome,
		replied: result.status !== 'applied' || !! result.autoFix,
	};
}

/**
 * How a provider takes part in the answer's loop of requests.
 */
export type ToolLoop< Answer, Result > = {
	/**
	 * Sends the conversation so far, and reads the answer, reporting its
	 * events through `onEvent`.
	 */
	readAnswer: ( onEvent: AiChatRequest[ 'onEvent' ] ) => Promise< Answer >;
	/**
	 * The tool calls of the answer, or `null` when the answer is done.
	 */
	getCalls: ( answer: Answer ) => ToolCall[] | null;
	/**
	 * Builds the result of a call, as it is sent back to the model.
	 */
	toResult: ( call: ToolCall, outcome: ToolOutcome ) => Result;
	/**
	 * Adds the answer and the results of its calls to the conversation.
	 */
	append: ( answer: Answer, results: Result[] ) => void;
	/**
	 * What the model is told when its edit does not match the tool.
	 */
	invalidEdit?: string;
};

/**
 * Answers a message: sends the conversation, runs the tools the model
 * calls, and sends their results back, until the model is done.
 *
 * @param loop    How the provider takes part.
 * @param request The request of the chat.
 */
export async function runToolLoop< Answer, Result >(
	loop: ToolLoop< Answer, Result >,
	request: Pick< AiChatRequest, 'onEvent' | 'read' >
): Promise< void > {
	const { readAnswer, getCalls, toResult, append, invalidEdit = INVALID_EDIT } = loop;
	const { onEvent, read } = request;
	const answerText = trackRequestText( onEvent );
	let failures = 0;
	let requests = 0;
	for (;;) {
		const answer = await readAnswer( answerText.onEvent );
		const text = answerText.take();
		const calls = getCalls( answer );
		if ( ! calls ) {
			return;
		}
		let replied = false;
		const results = calls.map( ( call ) => {
			const ran = runTool( call, onEvent, read, invalidEdit );
			replied ||= ran.replied;
			if ( ran.outcome.failed ) {
				failures++;
			}
			return toResult( call, ran.outcome );
		} );
		if ( endToolRequest( text, replied, onEvent ) ) {
			return;
		}
		if ( failures > MAX_RETRIES ) {
			throw new Error( __( 'The edit could not be made.', 'blocktune' ) );
		}
		if ( ++requests >= MAX_REQUESTS ) {
			throw new Error(
				__(
					'The answer was stopped because the AI took too many steps. The edits made so far are kept.',
					'blocktune'
				)
			);
		}
		append( answer, results );
	}
}
