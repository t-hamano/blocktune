/**
 * WordPress dependencies
 */
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from '@wordpress/element';

/**
 * Internal dependencies
 */
import {
	conversationReducer,
	createConversation,
	getLastSeenDocument,
	toAiMessages,
	toUserText,
	type Conversation,
} from './conversation';
import { buildMessageContext } from './document-context';
import { readDocument as answerRead } from './document-outline';
import type { EditTarget } from './edit-target';
import { buildSystemPrompt } from './prompt';
import { highlightChanges, takeBlockSnapshot } from '../editor/highlight';
import { getSiteInfo } from '../editor/site-info';
import type { AiEditResult, AiPlatform, AiRead } from '../platform';

type UseAiChatArgs = {
	ai: AiPlatform | undefined;
	/**
	 * Creates the edit target from the current selection, or returns `null` when the editor cannot provide one.
	 */
	createTarget: () => EditTarget | null;
};

export type AiChat = {
	conversation: Conversation;
	isResponding: boolean;
	sendMessage: ( text: string ) => void;
	stopAnswer: () => void;
	startNewConversation: () => void;
};

/**
 * Joins text that arrives in many small pieces, and passes it on once per
 * frame, so the chat does not render for each piece.
 *
 * Other changes to the conversation are made after committing the buffered
 * text, so they come after the text that arrived before them.
 *
 * @param onCommit Receives the joined text.
 * @return Functions that add text, commit the buffered text now, and drop it.
 */
function useFrameBufferedText( onCommit: ( text: string ) => void ) {
	const pendingTextRef = useRef( '' );
	const frameRef = useRef< number | null >( null );
	const discard = useCallback( () => {
		if ( frameRef.current !== null ) {
			cancelAnimationFrame( frameRef.current );
			frameRef.current = null;
		}
		pendingTextRef.current = '';
	}, [] );
	const commit = useCallback( () => {
		const text = pendingTextRef.current;
		discard();
		if ( text ) {
			onCommit( text );
		}
	}, [ discard, onCommit ] );
	const add = useCallback(
		( text: string ) => {
			pendingTextRef.current += text;
			if ( frameRef.current === null ) {
				frameRef.current = requestAnimationFrame( commit );
			}
		},
		[ commit ]
	);
	return { add, commit, discard };
}

/**
 * Runs a conversation with the AI assistant. The selection is captured when
 * a message is sent, and the model's edits are applied to it as they arrive.
 *
 * The first message carries the whole document, and later ones carry only
 * the blocks that changed since the last answer, and the blocks the model
 * added, whose reference IDs it has not seen. The conversation grows at its
 * end only, so the prompt cache covers what came before.
 *
 * @param args              Arguments.
 * @param args.ai           The host's connection to the model.
 * @param args.createTarget Creates the edit target.
 * @return The conversation and the actions on it.
 */
export function useAiChat( { ai, createTarget }: UseAiChatArgs ): AiChat {
	const [ conversation, updateConversation ] = useReducer(
		conversationReducer,
		undefined,
		createConversation
	);
	const messagesRef = useRef( conversation.messages );
	const controllerRef = useRef< AbortController | null >( null );
	// Reads the document when the answer being streamed ends.
	const readDocumentRef = useRef< ( () => string | undefined ) | null >( null );
	const appendText = useCallback(
		( text: string ) => updateConversation( { type: 'APPEND_TEXT', text } ),
		[]
	);
	const {
		add: addTextToBuffer,
		commit: commitBufferedText,
		discard: discardBufferedText,
	} = useFrameBufferedText( appendText );

	const sendMessage = useCallback(
		( text: string ) => {
			const message = text.trim();
			if ( ! ai || ! message || controllerRef.current ) {
				return;
			}
			const target = createTarget();
			const context = target?.getContext() ?? null;
			const messageContext = context
				? buildMessageContext( context, getLastSeenDocument( messagesRef.current ) )
				: undefined;
			const messages = [
				...toAiMessages( messagesRef.current ),
				{
					role: 'user' as const,
					text: toUserText( message, messageContext ),
				},
			];
			const controller = new AbortController();
			controllerRef.current = controller;
			// The document as the model knows it: as sent, with the model's
			// edits. Changes the user makes while the answer streams are left
			// out, so the next message tells the model about them.
			let seenDocument = context?.document;
			const readDocument = () => seenDocument;
			readDocumentRef.current = readDocument;
			commitBufferedText();
			updateConversation( {
				type: 'START',
				text: message,
				context: messageContext,
				document: context?.document,
			} );

			// Once the user stops the answer or starts a new conversation, the
			// request's late events and result are ignored.
			const isCurrent = () => controllerRef.current === controller && ! controller.signal.aborted;

			ai.chat( {
				system: buildSystemPrompt( context?.document ?? null, context ? getSiteInfo() : null ),
				messages,
				signal: controller.signal,
				// The model reads the document as it is now, with its edits.
				...( target
					? {
							read: ( read: AiRead ) => {
								const result = answerRead( target.getDocument(), read );
								// The model can now edit the blocks it read.
								if ( result.status === 'done' && read.tool === 'read_blocks' ) {
									target.markRead( read.refs );
								}
								return result;
							},
						}
					: {} ),
				onEvent( event ) {
					if ( ! isCurrent() ) {
						return;
					}
					if ( event.type === 'text' ) {
						addTextToBuffer( event.text );
						return;
					}
					if ( event.type === 'discard_text' ) {
						commitBufferedText();
						updateConversation( { type: 'DISCARD_TEXT', text: event.text } );
						return;
					}
					if ( event.type === 'usage' ) {
						commitBufferedText();
						updateConversation( { type: 'USAGE', usage: event.usage } );
						return;
					}
					if ( event.type === 'activity' ) {
						commitBufferedText();
						updateConversation( {
							type: 'ACTIVITY',
							activity: event.activity,
						} );
						return;
					}
					const before = target ? target.getDocument() : '';
					const blocksBefore = takeBlockSnapshot();
					const result: AiEditResult = target ? target.apply( event.edit ) : { status: 'dropped' };
					if ( target && result.status === 'applied' ) {
						highlightChanges( blocksBefore );
						// When the user also changed the document, the model
						// does not know it, so the next message sends the
						// whole document.
						seenDocument = seenDocument === before ? target.getDocument() : undefined;
					}
					// The model tries again after a failed edit, so the
					// answer shows only the edit that changed the document,
					// or that was dropped.
					if ( result.status !== 'failed' ) {
						commitBufferedText();
						updateConversation( {
							type: 'EDIT',
							edit: event.edit,
							applied: result.status === 'applied',
							// When the editor fixed the markup, the blocks
							// differ from what the model wrote, so the next
							// message sends them instead.
							...( result.status === 'applied' && result.refs?.length && ! result.autoFix
								? { refs: result.refs }
								: {} ),
						} );
					}
					return result;
				},
			} )
				.then(
					() => {
						if ( isCurrent() ) {
							commitBufferedText();
							updateConversation( {
								type: 'FINISH',
								status: 'done',
								documentAfter: readDocument(),
							} );
						}
					},
					( error: unknown ) => {
						if ( isCurrent() ) {
							commitBufferedText();
							updateConversation( {
								type: 'FINISH',
								status: 'error',
								error: error instanceof Error ? error.message : String( error ),
							} );
						}
					}
				)
				.finally( () => {
					if ( controllerRef.current === controller ) {
						controllerRef.current = null;
					}
				} );
		},
		[ ai, createTarget, addTextToBuffer, commitBufferedText ]
	);

	const stopAnswer = useCallback( () => {
		const controller = controllerRef.current;
		if ( ! controller ) {
			return;
		}
		controllerRef.current = null;
		controller.abort();
		commitBufferedText();
		updateConversation( {
			type: 'FINISH',
			status: 'stopped',
			documentAfter: readDocumentRef.current?.(),
		} );
	}, [ commitBufferedText ] );

	const startNewConversation = useCallback( () => {
		const controller = controllerRef.current;
		controllerRef.current = null;
		controller?.abort();
		discardBufferedText();
		updateConversation( { type: 'RESET' } );
	}, [ discardBufferedText ] );

	// Keep the latest messages for the callbacks, which run after rendering.
	useLayoutEffect( () => {
		messagesRef.current = conversation.messages;
	} );

	// Abandon the answer when the editor closes, so its late edits do not
	// reach a document that is gone.
	useEffect(
		() => () => {
			const controller = controllerRef.current;
			controllerRef.current = null;
			controller?.abort();
			discardBufferedText();
		},
		[ discardBufferedText ]
	);

	const last = conversation.messages[ conversation.messages.length - 1 ];
	const isResponding = last?.role === 'assistant' && last.status === 'streaming';

	return { conversation, isResponding, sendMessage, stopAnswer, startNewConversation };
}
