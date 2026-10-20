import { mountWidget } from 'skybridge/web';
import React, { useEffect, useState } from "react";
import { useToolInfo } from "skybridge/web";
import { Authenticator, useAuthenticator } from "@aws-amplify/ui-react";
import { Amplify } from 'aws-amplify';
import { fetchAuthSession } from "aws-amplify/auth";
import "@aws-amplify/ui-react/styles.css";

// Configure Amplify
Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID || 'us-east-2_mock',
      userPoolClientId: process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID || 'mock',
      identityPoolId: process.env.NEXT_PUBLIC_COGNITO_IDENTITY_POOL_ID || '',
      loginWith: {
        oauth: {
          domain: process.env.NEXT_PUBLIC_COGNITO_DOMAIN || '',
          scopes: ['phone', 'email', 'profile', 'openid', 'aws.cognito.signin.user.admin'],
          redirectSignIn: [process.env.NEXT_PUBLIC_FRONTEND_URL || 'https://app.delegare.dev'],
          redirectSignOut: [process.env.NEXT_PUBLIC_FRONTEND_URL || 'https://app.delegare.dev'],
          responseType: 'code'
        }
      }
    }
  }
});

function AuthContent() {
  const { output, isPending } = useToolInfo();
  const { authStatus } = useAuthenticator((context) => [context.authStatus]);

  if (isPending) {
    return (
      <div style={{ padding: "20px", background: "#0c0c0c", color: "#f0ede8", borderRadius: "16px", border: "1px solid rgba(240,237,232,0.1)" }}>
        <p style={{ margin: 0, fontSize: "14px", opacity: 0.5, fontFamily: "system-ui, -apple-system, sans-serif" }}>Loading secure connection...</p>
      </div>
    );
  }

  if (authStatus === 'authenticated') {
    return (
      <div style={{ padding: "32px", background: "#0c0c0c", color: "#f0ede8", borderRadius: "16px", border: "1px solid rgba(240,237,232,0.1)", textAlign: "center" }}>
        <div style={{ width: "48px", height: "48px", borderRadius: "24px", background: "rgba(200,185,154,0.1)", color: "#c8b99a", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6L9 17l-5-5"/>
          </svg>
        </div>
        <h3 style={{ margin: "0 0 8px 0", fontSize: "20px", fontWeight: "500", fontFamily: "system-ui, -apple-system, sans-serif" }}>Successfully authenticated</h3>
        <p style={{ margin: "0", fontSize: "15px", color: "rgba(240,237,232,0.7)", fontFamily: "system-ui, -apple-system, sans-serif" }}>
          You can now close this widget and continue your conversation.
        </p>
      </div>
    );
  }

  return (
    <div style={{ padding: "32px", background: "#0c0c0c", borderRadius: "16px", border: "1px solid rgba(240,237,232,0.1)", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <div style={{ textAlign: "center", marginBottom: "32px" }}>
        <h2 style={{ margin: "0 0 8px 0", fontSize: "24px", fontWeight: "500", color: "#f0ede8" }}>Log in to Delegare</h2>
        <p style={{ margin: 0, fontSize: "15px", color: "rgba(240,237,232,0.7)" }}>
          Access your merchant dashboard and API keys
        </p>
      </div>

      <Authenticator 
        loginMechanisms={['email']}
        socialProviders={['google']}
        signUpAttributes={['email']}
      />
    </div>
  );
}

export default function DelegareLogin() {
  return (
    <Authenticator.Provider>
      <AuthContent />
    </Authenticator.Provider>
  );
}

mountWidget(<DelegareLogin />);
