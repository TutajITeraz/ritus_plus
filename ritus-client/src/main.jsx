import React from 'react'
import ReactDOM from 'react-dom/client'
import { Provider } from "@/components/ui/provider"
import App from './App'
import { StrictMode } from 'react';

const root = ReactDOM.createRoot(document.getElementById('root'))
root.render(
    <StrictMode>
        <Provider forcedTheme="light" >
            <App />
        </Provider>
    </StrictMode>
)
