/**
 * API
 * No description provided (generated by Openapi Generator https://github.com/openapitools/openapi-generator)
 *
 * The version of the OpenAPI document: 1.0
 * 
 *
 * NOTE: This class is auto generated by OpenAPI Generator (https://openapi-generator.tech).
 * https://openapi-generator.tech
 * Do not edit the class manually.
 */
import { CredentialIssuer } from './credentialIssuer';


export interface CredentialResponse { 
    /**
     * Metadata for the issuer representation
     */
    issuer: CredentialIssuer;
    credential: object;
    /**
     * ID of the credential, has to be unique in combination with the user id.
     */
    id: string;
    /**
     * The user that owns the key
     */
    user: string;
    /**
     * The value of the credential
     */
    value: string;
    /**
     * Metadata to render the display
     */
    metaData: object;
}
