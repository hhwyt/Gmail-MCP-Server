import fs from 'fs';
import os from 'os';
import path from 'path';
import { lookup as mimeLookup } from 'mime-types';
import nodemailer from 'nodemailer';

/**
 * The only directory this server reads attachments from (send/draft) and writes
 * downloads to. Anything outside it is refused, so a prompt-injected request cannot
 * mail out ~/.ssh or overwrite ~/.zshrc.
 */
export const FILES_DIR = process.env.GMAIL_MCP_FILES_DIR || path.join(os.homedir(), 'Downloads', 'gmail-mcp');

function isInsideDirectory(directory: string, candidate: string): boolean {
    const relative = path.relative(directory, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Resolves a path (absolute, or relative to FILES_DIR) and returns its real path,
 * throwing unless it is inside FILES_DIR after symlinks are followed.
 * mode 'existing-file' is for attachments to send; 'directory' creates the folder for downloads.
 */
export function resolveInsideFilesDir(requestedPath: string, mode: 'existing-file' | 'directory'): string {
    fs.mkdirSync(FILES_DIR, { recursive: true });
    const filesDirRealPath = fs.realpathSync(FILES_DIR);
    const absolutePath = path.resolve(filesDirRealPath, requestedPath);
    const refusal = new Error(`Refused: ${requestedPath} is outside ${FILES_DIR}. Copy the file there first.`);

    if (!isInsideDirectory(filesDirRealPath, absolutePath)) throw refusal;
    if (mode === 'directory') {
        fs.mkdirSync(absolutePath, { recursive: true });
    } else if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
        throw new Error(`File does not exist: ${requestedPath}`);
    }
    const realPath = fs.realpathSync(absolutePath);
    if (!isInsideDirectory(filesDirRealPath, realPath)) throw refusal;
    return realPath;
}

/** Reduces a sender-controlled attachment name to a plain file name with no path parts. */
export function sanitizeAttachmentFilename(filename: string, fallback: string): string {
    const baseName = path.basename(filename.replace(/\\/g, '/')).replace(/[\x00-\x1f]/g, '').trim();
    if (!baseName || baseName === '.' || baseName === '..') return fallback;
    // A leading dot would create a hidden (and possibly shell-sourced) file
    return baseName.replace(/^\.+/, '_');
}

/**
 * Helper function to encode email headers containing non-ASCII characters
 * according to RFC 2047 MIME specification
 */
function encodeEmailHeader(text: string): string {
    // Only encode if the text contains non-ASCII characters
    if (/[^\x00-\x7F]/.test(text)) {
        // Use MIME Words encoding (RFC 2047)
        return '=?UTF-8?B?' + Buffer.from(text).toString('base64') + '?=';
    }
    return text;
}

export const validateEmail = (email: string): boolean => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
};

export function createEmailMessage(validatedArgs: any): string {
    const encodedSubject = encodeEmailHeader(validatedArgs.subject);
    // Determine content type based on available content and explicit mimeType
    let mimeType = validatedArgs.mimeType || 'text/plain';
    
    // If htmlBody is provided and mimeType isn't explicitly set to text/plain,
    // use multipart/alternative to include both versions
    if (validatedArgs.htmlBody && mimeType !== 'text/plain') {
        mimeType = 'multipart/alternative';
    }

    // Generate a random boundary string for multipart messages
    const boundary = `----=_NextPart_${Math.random().toString(36).substring(2)}`;

    // Validate email addresses
    (validatedArgs.to as string[]).forEach(email => {
        if (!validateEmail(email)) {
            throw new Error(`Recipient email address is invalid: ${email}`);
        }
    });

    // Common email headers
    const emailParts = [
        'From: me',
        `To: ${validatedArgs.to.join(', ')}`,
        validatedArgs.cc ? `Cc: ${validatedArgs.cc.join(', ')}` : '',
        validatedArgs.bcc ? `Bcc: ${validatedArgs.bcc.join(', ')}` : '',
        `Subject: ${encodedSubject}`,
        // Add thread-related headers if specified
        validatedArgs.inReplyTo ? `In-Reply-To: ${validatedArgs.inReplyTo}` : '',
        validatedArgs.inReplyTo ? `References: ${validatedArgs.inReplyTo}` : '',
        'MIME-Version: 1.0',
    ].filter(Boolean);

    // Construct the email based on the content type
    if (mimeType === 'multipart/alternative') {
        // Multipart email with both plain text and HTML
        emailParts.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
        emailParts.push('');
        
        // Plain text part
        emailParts.push(`--${boundary}`);
        emailParts.push('Content-Type: text/plain; charset=UTF-8');
        emailParts.push('Content-Transfer-Encoding: 7bit');
        emailParts.push('');
        emailParts.push(validatedArgs.body);
        emailParts.push('');
        
        // HTML part
        emailParts.push(`--${boundary}`);
        emailParts.push('Content-Type: text/html; charset=UTF-8');
        emailParts.push('Content-Transfer-Encoding: 7bit');
        emailParts.push('');
        emailParts.push(validatedArgs.htmlBody || validatedArgs.body); // Use body as fallback
        emailParts.push('');
        
        // Close the boundary
        emailParts.push(`--${boundary}--`);
    } else if (mimeType === 'text/html') {
        // HTML-only email
        emailParts.push('Content-Type: text/html; charset=UTF-8');
        emailParts.push('Content-Transfer-Encoding: 7bit');
        emailParts.push('');
        emailParts.push(validatedArgs.htmlBody || validatedArgs.body);
    } else {
        // Plain text email (default)
        emailParts.push('Content-Type: text/plain; charset=UTF-8');
        emailParts.push('Content-Transfer-Encoding: 7bit');
        emailParts.push('');
        emailParts.push(validatedArgs.body);
    }

    return emailParts.join('\r\n');
}


export async function createEmailWithNodemailer(validatedArgs: any): Promise<string> {
    // Validate email addresses
    (validatedArgs.to as string[]).forEach(email => {
        if (!validateEmail(email)) {
            throw new Error(`Recipient email address is invalid: ${email}`);
        }
    });

    // Create a nodemailer transporter (we won't actually send, just generate the message)
    const transporter = nodemailer.createTransport({
        streamTransport: true,
        newline: 'unix',
        buffer: true
    });

    // Prepare attachments for nodemailer
    const attachments = [];
    for (const requestedPath of validatedArgs.attachments) {
        const filePath = resolveInsideFilesDir(requestedPath, 'existing-file');
        const fileName = path.basename(filePath);
        
        attachments.push({
            filename: fileName,
            path: filePath
        });
    }

    const mailOptions = {
        from: 'me', // Gmail API will replace this with the authenticated user
        to: validatedArgs.to.join(', '),
        cc: validatedArgs.cc?.join(', '),
        bcc: validatedArgs.bcc?.join(', '),
        subject: validatedArgs.subject,
        text: validatedArgs.body,
        html: validatedArgs.htmlBody,
        attachments: attachments,
        inReplyTo: validatedArgs.inReplyTo,
        references: validatedArgs.inReplyTo
    };

    // Generate the raw message
    const info = await transporter.sendMail(mailOptions);
    const rawMessage = info.message.toString();
    
    return rawMessage;
}

