import { Progress as ChakraProgress } from "@chakra-ui/react"
import * as React from "react"

export const ProgressBar = React.forwardRef(function ProgressBar(props, ref) {
  const { showValueText, valueText, label, info, children, ...rest } = props
  return (
    <ChakraProgress.Root {...rest} ref={ref}>
      {label && (
        <ChakraProgress.Label>
          {label}
        </ChakraProgress.Label>
      )}
      <ChakraProgress.Track>
        <ChakraProgress.Range />
      </ChakraProgress.Track>
      {showValueText && (
        <ChakraProgress.ValueText>{valueText ?? `${props.value}%`}</ChakraProgress.ValueText>
      )}
      {children}
    </ChakraProgress.Root>
  )
})
